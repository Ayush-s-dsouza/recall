"""Thin wrapper around the Composio SDK for ReCall's two scoped integrations: Reddit (a
single shared service-account connection) and Notion (per-user OAuth for private/workspace
pages). See CLAUDE.md's Composio section for the full rationale — this module is a leaf: it
must never import from recall_core.py (recall_core.py imports from here, not the other way
around).

Named composio_integration, NOT composio_client — the `composio` SDK itself depends on a
separate installed package literally named `composio_client` (its internal API client), and a
same-named local file in this directory shadows that import and breaks the SDK outright
(confirmed directly: `from composio import Composio` raised ImportError until this was renamed).

Every function degrades to a safe falsy return (never raises) when COMPOSIO_API_KEY is unset
or a call fails/times out — callers treat that identically to "not connected" and fall back
to their existing non-Composio path, same convention as fetch_reddit()'s REDDIT_CLIENT_ID
check and send_save_ready_push()'s VAPID_PRIVATE_KEY check elsewhere in this codebase.

A Gmail-newsletter integration (per-user OAuth + a label-scoped trigger) was investigated and
deliberately dropped before implementation: Composio's Gmail trigger is poll-based (~2 min
interval, not push), so it offers no latency win over CloudMailin's existing forward-and-process
path, while requiring live OAuth read-access to the user's actual Gmail inbox — a real trust/
custody step up that wasn't worth it for a marginal UX gain. CloudMailin's forwarding path
(main.py's /webhooks/email-inbound) is untouched. See DECISION_LOG.md.

The composio SDK is synchronous (blocking network calls) — every public function here wraps
its real work in asyncio.to_thread(), the same pattern recall_core.py's _exec() uses to keep
blocking Supabase calls off the single asyncio event loop.
"""
import os
import re
import asyncio

from composio import Composio

COMPOSIO_API_KEY = os.getenv("COMPOSIO_API_KEY", "")
COMPOSIO_REDDIT_AUTH_CONFIG_ID = os.getenv("COMPOSIO_REDDIT_AUTH_CONFIG_ID", "")
COMPOSIO_REDDIT_CONNECTED_ACCOUNT_ID = os.getenv("COMPOSIO_REDDIT_CONNECTED_ACCOUNT_ID", "")
COMPOSIO_NOTION_AUTH_CONFIG_ID = os.getenv("COMPOSIO_NOTION_AUTH_CONFIG_ID", "")

# Fixed Composio "user_id" (entity id) for the single shared Reddit service connection — set
# once when the connection was created via connected_accounts.link(user_id=...). Reddit posts
# are public, so ReCall doesn't need per-ReCall-user consent — one connected account's token,
# reused for every user's fetch, mirrors the old app-only REDDIT_CLIENT_ID/SECRET architecture
# it replaces. Not a secret — just an identifier — so it's a constant, not an env var.
REDDIT_SERVICE_USER_ID = "recall-reddit-service"

_client = None


def is_configured() -> bool:
    return bool(COMPOSIO_API_KEY)


def _get_client() -> Composio:
    global _client
    if _client is None:
        _client = Composio(api_key=COMPOSIO_API_KEY)
    return _client


async def get_reddit_post_listing(article_id: str) -> list | None:
    """Fetch a Reddit post + comments via Composio's single shared service-account
    connection. Confirmed directly (2026-07-21) that REDDIT_RETRIEVE_POST_COMMENTS does NOT
    return Reddit's native bare 2-element listings array — it returns
    {"post_listing": {...}, "comments_listing": {...}}, each already in Reddit's per-listing
    shape ({"data": {"children": [...]}, "kind": "Listing"}). Adapted here into the bare
    [post_listing, comments_listing] shape _parse_reddit_listing() expects, so that function
    needed no shape change — only its field-level fallbacks did (see recall_core.py's
    _parse_reddit_listing for the subreddit-prefix/image-url fallbacks this response shape
    requires: it lacks subreddit_name_prefixed, post_hint, and preview.images entirely,
    confirmed directly against both a text post and multiple real r/pics image posts)."""
    if not (COMPOSIO_API_KEY and COMPOSIO_REDDIT_AUTH_CONFIG_ID):
        return None

    def _call():
        result = _get_client().tools.execute(
            "REDDIT_RETRIEVE_POST_COMMENTS",
            {"article": article_id},
            user_id=REDDIT_SERVICE_USER_ID,
            dangerously_skip_version_check=True,
        )
        if not result.get("successful"):
            return None
        data = result.get("data") or {}
        post_listing = data.get("post_listing")
        if not post_listing:
            return None
        comments_listing = data.get("comments_listing") or {"data": {"children": []}}
        return [post_listing, comments_listing]

    try:
        return await asyncio.to_thread(_call)
    except Exception as e:
        print(f"[composio][reddit] exception: {e!r} article_id={article_id}", flush=True)
        return None


_NOTION_ID_32HEX_RE = re.compile(r'([0-9a-fA-F]{32})$')
_NOTION_ID_HYPHENATED_RE = re.compile(
    r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
)


def _extract_notion_page_id(url: str) -> str | None:
    """NOTION_GET_PAGE_MARKDOWN requires a bare page UUID, not a URL (confirmed directly —
    its own parameter description says "Only page IDs are accepted"). A Notion share URL's
    page ID is always the last path segment: either a bare 32-hex-char string (the common
    case, e.g. notion.so/Page-Title-<32hex>) or already hyphenated. Accepts both, matching
    what the action itself accepts."""
    path = url.split("?")[0].rstrip("/")
    m = _NOTION_ID_32HEX_RE.search(path)
    if m:
        return m.group(1)
    m = _NOTION_ID_HYPHENATED_RE.search(path)
    return m.group(1) if m else None


async def get_notion_page_markdown(recall_user_id: str, page_url: str) -> tuple[str, str]:
    """Returns (markdown, title) for a Notion page the connected account can access.
    Confirmed directly: NOTION_GET_PAGE_MARKDOWN never returns a title field at all — callers
    must synthesize one downstream (extract_save_metadata_async), same as the existing Jina
    path's raw_title="Notion" pattern. Returns ("", "") on any failure (no page id extractable,
    not connected, page not shared with the integration, transient error) — callers fall back
    to the existing Jina scrape."""
    if not COMPOSIO_API_KEY:
        return "", ""
    page_id = _extract_notion_page_id(page_url)
    if not page_id:
        return "", ""

    def _call():
        result = _get_client().tools.execute(
            "NOTION_GET_PAGE_MARKDOWN",
            {"page_id": page_id},
            user_id=recall_user_id,
            dangerously_skip_version_check=True,
        )
        if not result.get("successful"):
            return "", ""
        markdown = (result.get("data") or {}).get("markdown") or ""
        return markdown, ""

    try:
        return await asyncio.to_thread(_call)
    except Exception as e:
        print(f"[composio][notion] exception: {e!r} user_id={recall_user_id}", flush=True)
        return "", ""


async def create_notion_connect_link(recall_user_id: str, callback_url: str) -> str | None:
    """Starts a per-user Notion OAuth connection via Composio's hosted Connect Link (the
    initiate() flow was retired for all orgs as of 2026-07-03; link() is its replacement).
    Returns the redirect URL the frontend should send the user to, or None if unconfigured/
    on failure."""
    if not (COMPOSIO_API_KEY and COMPOSIO_NOTION_AUTH_CONFIG_ID):
        return None

    def _call():
        req = _get_client().connected_accounts.link(
            user_id=recall_user_id,
            auth_config_id=COMPOSIO_NOTION_AUTH_CONFIG_ID,
            callback_url=callback_url,
        )
        return req.redirect_url

    try:
        return await asyncio.to_thread(_call)
    except Exception as e:
        print(f"[composio][notion] create_connect_link exception: {e!r}", flush=True)
        return None


async def get_connection_status(recall_user_id: str, toolkit: str) -> dict | None:
    """Returns {"connected_account_id": ..., "status": ...} if an active connection exists
    for this user_id + toolkit, else None (including on any error — treated as "not
    connected", not a hard failure)."""
    if not COMPOSIO_API_KEY:
        return None

    def _call():
        resp = _get_client().connected_accounts.list(
            user_ids=[recall_user_id], toolkit_slugs=[toolkit], statuses=["ACTIVE"],
        )
        if not resp.items:
            return None
        item = resp.items[0]
        return {"connected_account_id": item.id, "status": item.status}

    try:
        return await asyncio.to_thread(_call)
    except Exception as e:
        print(f"[composio] get_connection_status exception: {e!r} toolkit={toolkit}", flush=True)
        return None


async def disconnect_account(connected_account_id: str) -> bool:
    """Tears down a connected account on Composio's side (not just the local DB row)."""
    if not COMPOSIO_API_KEY:
        return False

    def _call():
        _get_client().connected_accounts.delete(connected_account_id, revoke_on_delete=True)
        return True

    try:
        return await asyncio.to_thread(_call)
    except Exception as e:
        print(f"[composio] disconnect_account exception: {e!r} id={connected_account_id}", flush=True)
        return False
