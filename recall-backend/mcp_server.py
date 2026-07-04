"""Remote MCP server for ReCall — lets Claude/ChatGPT connect as a custom OAuth 2.1
connector. Mounted into main.py's FastAPI app (see mount_mcp_server()).

Endpoint layout (see create_auth_routes() in the mcp SDK): OAuth endpoints
(/authorize, /token, /register, /revoke, /.well-known/oauth-authorization-server)
live at the backend's root, and the actual MCP protocol endpoint lives at /mcp —
this matches RFC 8414's expectation that an issuer with no path component serves
its metadata at /.well-known/oauth-authorization-server, and keeps the user-facing
connector URL a clean "${BACKEND_URL}/mcp".
"""
import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

from cachetools import TTLCache
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from recall_core import (
    do_delete_save,
    do_search,
    do_suggestions,
    do_update_tag,
    do_update_title,
    process_save,
    supabase,
)

BACKEND_PUBLIC_URL = os.environ.get("BACKEND_PUBLIC_URL", "http://localhost:8000")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")

ACCESS_TOKEN_TTL_SECONDS = 30 * 60
REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60
AUTH_CODE_TTL_SECONDS = 5 * 60
SCOPE = "recall"

# Access-token lookups happen on every tool call, on top of the do_* function's own
# Supabase query — this small TTL cache avoids doubling per-call latency.
_access_token_cache: TTLCache = TTLCache(maxsize=4096, ttl=60)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


def _is_allowed_redirect_uri(uri: str) -> bool:
    if uri.startswith("https://"):
        return True
    host = uri.split("://", 1)[-1].split("/", 1)[0].split(":")[0]
    return uri.startswith("http://") and host in ("localhost", "127.0.0.1")


class RecallOAuthProvider:
    """Implements mcp.server.auth.provider.OAuthAuthorizationServerProvider against
    the mcp_oauth_clients / mcp_auth_codes / mcp_tokens tables (see sql/001_mcp_oauth.sql).
    Not subclassed from the Protocol — structural typing is enough."""

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        row = supabase.table("mcp_oauth_clients").select("*").eq("client_id", client_id).limit(1).execute()
        if not row.data:
            return None
        c = row.data[0]
        return OAuthClientInformationFull(
            client_id=c["client_id"],
            client_secret=c.get("client_secret"),
            redirect_uris=c["redirect_uris"],
            grant_types=c["grant_types"],
            token_endpoint_auth_method=c["token_endpoint_auth_method"],
            client_name=c.get("client_name"),
            scope=SCOPE,
        )

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        for uri in client_info.redirect_uris or []:
            if not _is_allowed_redirect_uri(str(uri)):
                raise RegistrationError(
                    error="invalid_redirect_uri",
                    error_description="redirect_uris must be https:// (http://localhost is allowed for local testing)",
                )
        supabase.table("mcp_oauth_clients").insert({
            "client_id": client_info.client_id,
            # client_secret is a server-generated high-entropy random value (not a
            # user password) — the SDK's ClientAuthenticator compares it via
            # hmac.compare_digest against the raw value the client presents at
            # /token, which requires get_client() to return the original plaintext.
            # Hashing it would break confidential-client auth. In practice
            # Claude/ChatGPT register as public PKCE-only clients
            # (token_endpoint_auth_method="none"), so this is usually null.
            "client_secret": client_info.client_secret,
            "client_name": client_info.client_name,
            "redirect_uris": [str(u) for u in (client_info.redirect_uris or [])],
            "grant_types": client_info.grant_types,
            "token_endpoint_auth_method": client_info.token_endpoint_auth_method,
        }).execute()

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        return construct_redirect_uri(
            f"{FRONTEND_URL}/mcp/consent",
            client_id=client.client_id,
            client_name=client.client_name,
            state=params.state,
            redirect_uri=str(params.redirect_uri),
            code_challenge=params.code_challenge,
            code_challenge_method="S256",
            scope=" ".join(params.scopes) if params.scopes else None,
            resource=params.resource,
        )

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        row = supabase.table("mcp_auth_codes").select("*") \
            .eq("code", authorization_code).eq("client_id", client.client_id).eq("used", False) \
            .limit(1).execute()
        if not row.data:
            return None
        c = row.data[0]
        return AuthorizationCode(
            code=c["code"],
            scopes=c["scope"].split() if c.get("scope") else [],
            expires_at=datetime.fromisoformat(c["expires_at"]).timestamp(),
            client_id=c["client_id"],
            code_challenge=c["code_challenge"],
            redirect_uri=c["redirect_uri"],
            redirect_uri_provided_explicitly=c["redirect_uri_provided_explicitly"],
            resource=c.get("resource"),
            subject=c["user_id"],
        )

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        # Atomically claim the code — update only succeeds (returns a row) the first time.
        claimed = supabase.table("mcp_auth_codes").update({"used": True}) \
            .eq("code", authorization_code.code).eq("used", False).execute()
        if not claimed.data:
            raise TokenError(error="invalid_grant", error_description="authorization code already used")

        access_token = _new_token("ra")
        refresh_token = _new_token("rr")
        now = datetime.now(timezone.utc)
        scope_str = " ".join(authorization_code.scopes) if authorization_code.scopes else None

        supabase.table("mcp_tokens").insert({
            "access_token_hash": _hash(access_token),
            "refresh_token_hash": _hash(refresh_token),
            "client_id": client.client_id,
            "user_id": authorization_code.subject,
            "scope": scope_str,
            "access_token_expires_at": (now + timedelta(seconds=ACCESS_TOKEN_TTL_SECONDS)).isoformat(),
            "refresh_token_expires_at": (now + timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS)).isoformat(),
        }).execute()

        return OAuthToken(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            scope=scope_str,
        )

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str):
        from mcp.server.auth.provider import RefreshToken

        row = supabase.table("mcp_tokens").select("*") \
            .eq("refresh_token_hash", _hash(refresh_token)).eq("client_id", client.client_id).eq("revoked", False) \
            .limit(1).execute()
        if not row.data:
            return None
        t = row.data[0]
        expires_at = None
        if t.get("refresh_token_expires_at"):
            expires_at = int(datetime.fromisoformat(t["refresh_token_expires_at"]).timestamp())
        return RefreshToken(
            token=refresh_token,
            client_id=t["client_id"],
            scopes=t["scope"].split() if t.get("scope") else [],
            expires_at=expires_at,
            subject=t["user_id"],
        )

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token, scopes) -> OAuthToken:
        new_access = _new_token("ra")
        new_refresh = _new_token("rr")
        now = datetime.now(timezone.utc)

        result = supabase.rpc("mcp_exchange_refresh_token", {
            "p_old_refresh_token_hash": _hash(refresh_token.token),
            "p_new_access_token_hash": _hash(new_access),
            "p_new_refresh_token_hash": _hash(new_refresh),
            "p_access_token_expires_at": (now + timedelta(seconds=ACCESS_TOKEN_TTL_SECONDS)).isoformat(),
            "p_refresh_token_expires_at": (now + timedelta(seconds=REFRESH_TOKEN_TTL_SECONDS)).isoformat(),
        }).execute()

        if not result.data:
            raise TokenError(error="invalid_grant", error_description="refresh token not found")

        row = result.data[0]
        # Evict the rotated-away access token immediately — otherwise a still-warm
        # cache entry from load_access_token() would keep serving it as valid for
        # up to its TTL after this row was revoked.
        if row.get("old_access_token_hash"):
            _access_token_cache.pop(row["old_access_token_hash"], None)

        if row["theft_detected"]:
            raise TokenError(
                error="invalid_grant",
                error_description="refresh token reuse detected — all tokens for this client revoked, re-authorize",
            )

        return OAuthToken(
            access_token=new_access,
            refresh_token=new_refresh,
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            scope=row.get("scope"),
        )

    async def load_access_token(self, token: str) -> AccessToken | None:
        # Keyed by hash (not the raw token) so rotation/revocation can evict an
        # entry knowing only the hash, without ever needing the plaintext back.
        token_hash = _hash(token)
        cached = _access_token_cache.get(token_hash, "MISS")
        if cached != "MISS":
            return cached

        row = supabase.table("mcp_tokens").select("*") \
            .eq("access_token_hash", token_hash).eq("revoked", False).limit(1).execute()
        if not row.data:
            _access_token_cache[token_hash] = None
            return None
        t = row.data[0]
        expires_at_dt = datetime.fromisoformat(t["access_token_expires_at"])
        if expires_at_dt < datetime.now(timezone.utc):
            _access_token_cache[token_hash] = None
            return None

        access_token = AccessToken(
            token=token,
            client_id=t["client_id"],
            scopes=t["scope"].split() if t.get("scope") else [],
            expires_at=int(expires_at_dt.timestamp()),
            subject=t["user_id"],
        )
        _access_token_cache[token_hash] = access_token
        return access_token

    async def revoke_token(self, token) -> None:
        token_hash = _hash(token.token)
        supabase.table("mcp_tokens").update({"revoked": True}).eq("access_token_hash", token_hash).execute()
        supabase.table("mcp_tokens").update({"revoked": True}).eq("refresh_token_hash", token_hash).execute()
        _access_token_cache.pop(token_hash, None)


def _current_user_id() -> str:
    access_token = get_access_token()
    if access_token is None or not access_token.subject:
        raise PermissionError("No authenticated user for this request")
    return access_token.subject


provider = RecallOAuthProvider()

mcp = FastMCP(
    name="ReCall",
    instructions="Search, save, and manage URLs in the user's ReCall library.",
    auth_server_provider=provider,
    auth=AuthSettings(
        issuer_url=BACKEND_PUBLIC_URL,
        resource_server_url=f"{BACKEND_PUBLIC_URL}/mcp",
        client_registration_options=ClientRegistrationOptions(
            enabled=True, valid_scopes=[SCOPE], default_scopes=[SCOPE]
        ),
        revocation_options=RevocationOptions(enabled=True),
    ),
    streamable_http_path="/mcp",
    # FastMCP auto-enables DNS-rebinding Host-header protection (with a
    # localhost-only allowlist) whenever its `host` param isn't set, which
    # defaults to "127.0.0.1" — even though that param only matters for
    # FastMCP's own standalone dev server (mcp.run()), which we never use; we
    # mount streamable_http_app() into our own uvicorn process instead. Left
    # unset, every real request in production gets rejected with
    # "421 Misdirected Request: Invalid Host header: <railway-domain>".
    # DNS rebinding protection guards localhost-bound dev servers against
    # malicious websites in the victim's own browser — not relevant for a
    # public HTTPS API where OAuth bearer tokens are the actual access
    # control, so disable it rather than maintain a Host/Origin allowlist
    # across every client environment (local, Railway, Claude, ChatGPT).
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@mcp.tool()
async def recall_search(query: str) -> dict:
    """Search the user's saved URLs by semantic similarity."""
    return await do_search(query, _current_user_id())


@mcp.tool()
async def recall_save(url: str) -> dict:
    """Save a URL to the user's ReCall library."""
    return await process_save(url, _current_user_id())


@mcp.tool()
async def recall_suggestions() -> dict:
    """Get tag/source-based search suggestions for the user's library."""
    return await do_suggestions(_current_user_id())


@mcp.tool()
async def recall_update_tag(save_id: str, tag: str) -> dict:
    """Update the category tag on a saved URL. Valid tags: Tech, Product, Business, Finance, Health, Personal, Other."""
    try:
        return await do_update_tag(save_id, tag, _current_user_id())
    except ValueError as e:
        raise ValueError(str(e))


@mcp.tool()
async def recall_update_title(save_id: str, title: str) -> dict:
    """Update the title on a saved URL."""
    return await do_update_title(save_id, title, _current_user_id())


@mcp.tool()
async def recall_delete(save_id: str) -> dict:
    """Delete a saved URL from the user's library."""
    return await do_delete_save(save_id, _current_user_id())


def mcp_asgi_app():
    return mcp.streamable_http_app()
