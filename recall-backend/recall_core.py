"""Shared business logic for ReCall, used by both the REST API (main.py) and the
remote MCP server (mcp_server.py). Kept in its own module so main.py can mount
mcp_server.py's ASGI app without a circular import.
"""
import os
import re
import json
import math
import time
import socket
import ipaddress
import asyncio
import html as html_entities
from urllib.parse import urlparse, parse_qs, quote, urljoin
from concurrent.futures import ThreadPoolExecutor

import httpx
import jwt
import yt_dlp
from jwt import PyJWKClient
from fastapi import HTTPException
from dotenv import load_dotenv
from supabase import create_client
from postgrest import APIError
from google import genai
from google.genai import types
from pywebpush import webpush, WebPushException
from bs4 import BeautifulSoup

load_dotenv()

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))

# Module-level Gemini client — created once at startup, reused across all requests
gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
_executor = ThreadPoolExecutor(max_workers=4)

async def _exec(query_builder):
    """Runs a synchronous postgrest query-builder's .execute() in a thread, so it doesn't
    block the single asyncio event loop this app runs on (a bare `uvicorn main:app`, one
    worker process). Every blocking Supabase call previously ran inline on the event loop,
    serializing concurrent requests behind each other's network I/O — see CLAUDE.md's
    event-loop-blocking investigation."""
    return await asyncio.to_thread(query_builder.execute)

# Local JWT verification (see get_user_id below) — this project's Supabase instance
# signs access tokens with an asymmetric ES256 key (confirmed via its JWKS endpoint,
# not the legacy HS256 shared-secret scheme), so verification fetches the public key
# from JWKS rather than needing a secret. PyJWKClient caches fetched keys in-process,
# so this doesn't reintroduce a network call on every request — only on cache miss.
_jwks_client = PyJWKClient(f"{os.getenv('SUPABASE_URL')}/auth/v1/.well-known/jwks.json")
# Kill-switch for the rollout: "network" (default) keeps using the old, slower but
# battle-tested get_user() API call and additionally canary-logs the local-verification
# result alongside it for comparison; "local" switches to local-only verification once
# canary logs confirm the two agree. See CLAUDE.md's save-latency plan for the rollout.
AUTH_VERIFY_MODE = os.getenv("AUTH_VERIFY_MODE", "network")

# Typed ThinkingConfig — disables thinking tokens for all generate_content calls.
# Falls back to empty config on old SDK versions that predate ThinkingConfig.
try:
    _NO_THINKING = types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_budget=0)
    )
    # Dedicated config for extract_topics only (round 4 — see CLAUDE.md Known Issue #36).
    # Unlike every other Gemini call site in this file, this one keeps thinking ENABLED —
    # measured directly in round 3 (the query-time relevance filter this replaced): with
    # thinking disabled, the model judges content on surface wording alone and misses
    # named-entity knowledge (e.g. failed to recognize "Paradigm" as a crypto VC fund).
    # thinking_budget=1024 fixed this in testing; smaller budgets (64-512) reverted to the
    # same shallow, entity-blind judgments. Spent at save time, where the extra ~3-5s is
    # invisible to the user (background enrichment, see Known Issue #1b) rather than at
    # query time, where it isn't.
    _TOPIC_EXTRACTION_CONFIG = types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_budget=1024),
        temperature=0
    )
except AttributeError:
    _NO_THINKING = types.GenerateContentConfig()
    _TOPIC_EXTRACTION_CONFIG = types.GenerateContentConfig(temperature=0)

# --- SSRF protection ---
_PRIVATE_RANGES = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]

def is_safe_url(url: str) -> bool:
    """Return True if the URL resolves to a public IP (not private/internal)."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        for info in socket.getaddrinfo(hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            # An IPv4-mapped IPv6 literal (::ffff:169.254.169.254) is a distinct address
            # family from any entry in _PRIVATE_RANGES, so `ip in net` silently returns False
            # for every range even though it denotes the same private/metadata address —
            # unwrap it to the underlying IPv4Address before checking.
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
                ip = ip.ipv4_mapped
            if any(ip in net for net in _PRIVATE_RANGES):
                return False
        return True
    except Exception:
        return False

async def validate_url(url: str):
    """Raise 400 if URL is not safe to fetch."""
    if not await asyncio.to_thread(is_safe_url, url):
        raise HTTPException(status_code=400, detail="Invalid URL")

async def safe_get(client: httpx.AsyncClient, url: str, *, max_redirects: int = 5, **kwargs) -> httpx.Response:
    """GET with every redirect hop re-validated by is_safe_url() before being followed.
    httpx's follow_redirects=True trusts the whole redirect chain with no re-check, so a
    public domain that 302s to an internal/metadata address would otherwise sail through
    after only the initial hostname passed the SSRF check. Use this instead of
    follow_redirects=True for any URL that isn't a hardcoded internal constant."""
    current_url = url
    for _ in range(max_redirects + 1):
        if not await asyncio.to_thread(is_safe_url, current_url):
            raise ValueError(f"blocked unsafe URL: {current_url}")
        response = await client.get(current_url, follow_redirects=False, **kwargs)
        if 300 <= response.status_code < 400 and "location" in response.headers:
            current_url = urljoin(current_url, response.headers["location"])
            continue
        return response
    raise ValueError("too many redirects")

MEDIA_URLS = [
    ("youtube.com/watch",    "video", "YouTube videos"),
    ("youtube.com/shorts/",  "video", "YouTube Shorts"),
    ("youtu.be/",            "video", "YouTube videos"),
    ("tiktok.com/",          "video", "TikTok videos"),
    ("instagram.com/reel/",  "video", "Instagram Reels"),
    ("instagram.com/p/",     "image", "Instagram posts"),
]
QUALITY_THRESHOLD = 100  # chars — below this, content is too thin to be useful
MAX_VIDEO_TRANSCRIPT_CHARS = 10000  # transcripts run much longer than article text; empirically
                                     # generous like every other search-tuning constant in this file
TWEET_URL_RE = re.compile(r'(?:twitter\.com|x\.com)/\w{1,15}/status/(\d{1,20})')

def _get_user_id_local(token: str) -> str:
    signing_key = _jwks_client.get_signing_key_from_jwt(token).key
    claims = jwt.decode(token, signing_key, algorithms=["ES256"], audience="authenticated")
    return claims["sub"]

def _get_user_id_network(token: str) -> str:
    user = supabase.auth.get_user(token)
    return user.user.id

async def get_user_id(token: str) -> str:
    """Resolve a Supabase access token to a user_id. Local verification (decode + check
    signature/exp/aud against Supabase's own JWKS) replaces a blocking network round-trip
    to Supabase's GoTrue /auth/v1/user endpoint that every authenticated request previously
    paid for — see CLAUDE.md's save-latency plan. AUTH_VERIFY_MODE gates the rollout.
    Both paths run via asyncio.to_thread — _get_user_id_network always blocks on network I/O,
    and _get_user_id_local can too on a JWKS cache miss/key rotation (PyJWKClient's internal
    fetch is a plain blocking call), so neither is safe to call inline on the event loop."""
    if AUTH_VERIFY_MODE == "local":
        try:
            return await asyncio.to_thread(_get_user_id_local, token)
        except jwt.PyJWTError:
            raise HTTPException(status_code=401, detail="Invalid token")

    user_id = await asyncio.to_thread(_get_user_id_network, token)
    try:
        local_user_id = await asyncio.to_thread(_get_user_id_local, token)
        if local_user_id != user_id:
            print(f"[auth_canary] MISMATCH network={user_id} local={local_user_id}", flush=True)
    except Exception as e:
        print(f"[auth_canary] local verification failed: {e}", flush=True)
    return user_id

async def _duplicate_response(user_id: str, url: str) -> dict:
    """Fetch an existing (user_id, url) row's details for a duplicate response — shared by
    every save path that can hit this, including a race against the saves_user_id_url_key
    unique constraint (sql/012_saves_unique_user_url.sql) when a concurrent save of the same
    URL wins between an earlier duplicate check and this row's own insert."""
    existing = await _exec(supabase.table("saves")
        .select("id, title, tag, created_at")
        .eq("user_id", user_id).eq("url", url)
        .limit(1))
    row = existing.data[0]
    return {"duplicate": True, "id": row["id"], "title": row["title"],
            "tag": row["tag"], "created_at": row["created_at"]}

def get_source_label(url: str) -> str:
    if not url:
        return "Page"
    if "twitter.com" in url or "x.com" in url:
        return "X (Twitter)"
    if "linkedin.com" in url:
        return "LinkedIn"
    if "reddit.com" in url:
        return "Reddit"
    if "notion.so" in url or "notion.site" in url or "app.notion.com" in url:
        return "Notion"
    if "youtube.com" in url or "youtu.be" in url:
        return "YouTube"
    if "substack.com" in url:
        return "Substack"
    try:
        host = urlparse(url).hostname or ""
        host = host.replace("www.", "")
        return host.capitalize() if host else "Page"
    except:
        return "Page"

async def send_save_ready_push(user_id: str, title: str, source_label: str):
    """Best-effort Web Push notification that a backgrounded save finished enriching.
    Never raises — a push failure must never affect the save itself."""
    vapid_private_key = os.getenv("VAPID_PRIVATE_KEY")
    if not vapid_private_key:
        return
    try:
        result = await _exec(supabase.table("push_subscriptions")
            .select("id, endpoint, p256dh, auth").eq("user_id", user_id))
        subs = result.data
    except Exception:
        return
    for sub in subs:
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}
                },
                data=json.dumps({"title": f'Saved "{title}"', "body": f"from {source_label}"}),
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": os.getenv("VAPID_SUBJECT", "mailto:noreply@example.com")},
                # Without this, FCM treats the push as "normal" urgency and Android can defer
                # delivery to a Doze/App Standby maintenance window — sometimes minutes to hours
                # later — instead of waking the device immediately.
                headers={"Urgency": "high"}
            )
        except WebPushException as e:
            body = e.response.text if e.response is not None else ""
            print(f"[push] WebPushException status={e.response.status_code if e.response is not None else None} body={body!r}", flush=True)
            if e.response is not None and e.response.status_code in (404, 410):
                try:
                    await _exec(supabase.table("push_subscriptions").delete().eq("id", sub["id"]))
                except Exception:
                    pass
        except Exception as e:
            print(f"[push] send failed: {e!r}", flush=True)

async def get_embedding(text: str, task_type: str = "RETRIEVAL_DOCUMENT"):
    """task_type: RETRIEVAL_DOCUMENT for saved content (default), RETRIEVAL_QUERY for
    search queries — Gemini's embedding space is asymmetric between the two, and using
    the same generic embedding for both compresses similarity scores (see CLAUDE.md
    Known Issue #33)."""
    api_key = os.getenv("GEMINI_API_KEY")
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key={api_key}",
            json={
                "model": "models/gemini-embedding-001",
                "content": {"parts": [{"text": text[:8000]}]},
                "taskType": task_type,
                "outputDimensionality": 768
            }
        )
    data = response.json()
    if "embedding" not in data:
        print(f"[embedding] Gemini API error (status {response.status_code}): {data}", flush=True)
        error_msg = data.get("error", {}).get("message", "unknown error")
        raise HTTPException(status_code=503, detail=f"Embedding service error: {error_msg}")
    return data["embedding"]["values"]

def extract_save_metadata(raw_title: str, content: str, extra_context: str = ""):
    try:
        client = gemini_client
        context_block = content[:1500]
        if extra_context:
            context_block += f"\n\nAdditional context (post description / image content):\n{extra_context[:800]}"
        # Don't call Gemini with an essentially empty prompt — it produces garbage titles
        if len(context_block.strip()) < 30:
            return raw_title or "Saved post", "Other"
        prompt = f"""Analyze this web content and return exactly three lines:
Line 1: A concise, accurate title (max 8 words) describing what this specific content is about — not the platform name
Line 2: The author's full name, or organisation name if no individual author. Write "Unknown" if not found.
Line 3: One category from: Tech, Product, Business, Finance, Health, Personal, Other

Raw title: {raw_title}
Content: {context_block}

Respond with exactly three lines, nothing else."""
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=_NO_THINKING
        )
        lines = [l.strip() for l in response.text.strip().split('\n') if l.strip()]
        ai_title = lines[0] if lines else raw_title
        author = lines[1] if len(lines) > 1 else "Unknown"
        tag_raw = lines[2] if len(lines) > 2 else "Other"
        valid_tags = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]
        tag = tag_raw if tag_raw in valid_tags else "Other"
        display_title = f"{ai_title} · {author}" if author.lower() != "unknown" else ai_title
        return display_title, tag
    except:
        return raw_title, "Other"

async def extract_save_metadata_async(raw_title: str, content: str, extra_context: str = ""):
    """Runs extract_save_metadata in a thread with a bounded timeout so a slow/rate-limited
    Gemini call can't block the event loop — falls back like extract_save_metadata's own except."""
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(_executor, extract_save_metadata, raw_title, content, extra_context),
            timeout=12.0
        )
    except asyncio.TimeoutError:
        return raw_title, "Other"

def extract_topics(title: str, content: str, extra_context: str = "") -> str:
    """Distill a save down to a short, concentrated topic/entity phrase, embedded separately
    at save time so query-time search can compare against a clean signal instead of a diluted
    full-content vector — see CLAUDE.md Known Issue #36."""
    context_block = content[:1500]
    if extra_context:
        context_block += f"\n\nAdditional context:\n{extra_context[:800]}"
    if len(context_block.strip()) < 30:
        return title or ""
    prompt = f"""Name the 3-6 topics and named entities (companies, funds, products,
protocols, people) this content is really about. Use your knowledge of what named
entities are/do — e.g. if a fund or company is mentioned, name the industry it's known
for. Be specific and concrete, not generic.

Title: {title}
Content: {context_block}

Respond with a single comma-separated line, nothing else. Example: crypto, venture
capital, Paradigm fellowship"""
    try:
        response = gemini_client.models.generate_content(
            model="gemini-2.5-flash", contents=prompt, config=_TOPIC_EXTRACTION_CONFIG
        )
        return response.text.strip()
    except Exception:
        return title or ""

async def extract_topics_async(title: str, content: str, extra_context: str = "") -> str:
    """Runs extract_topics in a thread with a bounded timeout, mirroring extract_save_metadata_async."""
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(_executor, extract_topics, title, content, extra_context),
            timeout=12.0
        )
    except asyncio.TimeoutError:
        return title or ""

def decode_html_entities(s: str) -> str:
    """Decode HTML entities, including the double-encoded form some sites (e.g. LinkedIn)
    serve in meta tags (&amp;#39; instead of &#39;). A second pass is safe/idempotent for
    normally-encoded text — unescape() doesn't re-scan its own output for new entities."""
    if not s:
        return s
    return html_entities.unescape(html_entities.unescape(s))

def extract_og_tags(html: str) -> dict:
    """Extract Open Graph and meta description tags from raw HTML."""
    result = {}
    for meta in re.finditer(r'<meta\s+([^>]+?)/?>', html, re.IGNORECASE | re.DOTALL):
        attrs_str = meta.group(1)
        prop_match = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', attrs_str, re.IGNORECASE)
        content_match = re.search(r'content\s*=\s*["\']([^"\']*)["\']', attrs_str, re.IGNORECASE)
        if prop_match and content_match:
            result[prop_match.group(1).lower()] = decode_html_entities(content_match.group(1).strip())
    return result

async def analyze_image(image_url: str) -> str:
    """Use Gemini vision to describe image content — used when page text is sparse."""
    if not is_safe_url(image_url):
        return ""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Referer": image_url,
        }
        async with httpx.AsyncClient(timeout=15, headers=headers) as client:
            res = await safe_get(client, image_url)
            image_bytes = res.content
            mime_type = res.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            # Reject if too small (likely an error page) or clearly not an image
            if len(image_bytes) < 1000:
                return ""
            if not mime_type.startswith("image/") and mime_type not in ("application/octet-stream",):
                return ""
            # Force a safe mime type if CDN returns octet-stream
            if mime_type == "application/octet-stream":
                mime_type = "image/jpeg"
        loop = asyncio.get_running_loop()
        response = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                lambda: gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=[
                        types.Content(role="user", parts=[
                            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                            types.Part.from_text(
                                "Describe what this image contains in 2-3 sentences. "
                                "If there is visible text, include it. Focus on the main subject, "
                                "people, brands, or key information shown."
                            )
                        ])
                    ],
                    config=_NO_THINKING
                )
            ),
            timeout=12.0
        )
        return response.text.strip()
    except:
        return ""

async def fetch_instagram(url: str):
    """Fetch Instagram post content via the embed endpoint (no auth required for public posts)."""
    from html.parser import HTMLParser

    match = re.search(r'instagram\.com/(p|reel|tv)/([A-Za-z0-9_-]+)', url)
    if not match:
        return "", "", ""
    post_type, shortcode = match.group(1), match.group(2)
    embed_url = f"https://www.instagram.com/{post_type}/{shortcode}/embed/captioned/"

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        async with httpx.AsyncClient(timeout=15, headers=headers) as client:
            res = await safe_get(client, embed_url)
            html = res.text

        print(f"[instagram] embed status={res.status_code}", flush=True)

        # Extract username — try several patterns across embed versions
        author = ""
        for pattern in [
            r'"username"\s*:\s*"([^"]+)"',                              # JSON field
            r'<title>[^<]*by\s+([A-Za-z0-9_.]+)\s*[•·|]',              # "photo by username •"
            r'href="https://www\.instagram\.com/([A-Za-z0-9_.]+)/?["\?]',  # profile link
            r'@([A-Za-z0-9_.]{3,30})',                                  # @mention anywhere
        ]:
            m = re.search(pattern, html, re.IGNORECASE)
            if m:
                candidate = m.group(1).strip()
                if candidate and candidate not in ('p', 'reel', 'tv', 'explore', 'accounts', 'instagram'):
                    author = candidate
                    break

        # Extract all visible text from the embed page — avoids brittle JSON regex
        class TextExtractor(HTMLParser):
            def __init__(self):
                super().__init__()
                self.chunks = []
                self.skip = False
            def handle_starttag(self, tag, attrs):
                if tag in ('script', 'style', 'head'):
                    self.skip = True
            def handle_endtag(self, tag):
                if tag in ('script', 'style', 'head'):
                    self.skip = False
            def handle_data(self, data):
                if not self.skip:
                    stripped = data.strip()
                    if stripped:
                        self.chunks.append(stripped)

        parser = TextExtractor()
        parser.feed(html)
        all_text = " ".join(parser.chunks)

        # Combine all chunks longer than 15 chars — skips UI noise like "Like", "Share"
        meaningful_chunks = [c for c in parser.chunks if len(c) > 15]
        caption = " ".join(meaningful_chunks)[:2000] if meaningful_chunks else all_text[:1000]

        # Strip leading Instagram UI boilerplate (follower counts, profile stats)
        caption = re.sub(r'^[\d\w\s,\.·•]+(?:posts?|followers?|following)[^a-z]*', '', caption, flags=re.IGNORECASE).strip()
        caption = re.sub(r'^View more on Instagram\s*', '', caption, flags=re.IGNORECASE).strip()

        return caption, author, ""  # skip thumbnail — Instagram CDN blocks direct access
    except Exception as e:
        print(f"[instagram] embed fetch failed: {e}", flush=True)
        return "", "", ""

def _extract_youtube_info(url: str) -> dict:
    """Blocking yt-dlp metadata call — run in a thread. skip_download=True means this never
    invokes ffmpeg or writes any file; it only hits YouTube's metadata endpoints."""
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)

async def _extract_youtube_info_with_retry(url: str, attempts: int = 2) -> dict | None:
    """One retry around _extract_youtube_info — this single call is the whole video-save
    pipeline's point of failure, and a transient hiccup (network blip, cold-start after a
    fresh deploy) shouldn't silently degrade a real, fetchable video into a blank
    placeholder. Confirmed directly: a real save failed on its first attempt then succeeded
    on every subsequent call with no code change, consistent with a one-off transient
    failure rather than a real bug. See CLAUDE.md's video-support round."""
    last_error = None
    for attempt in range(attempts):
        try:
            return await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(_executor, _extract_youtube_info, url),
                timeout=20.0
            )
        except Exception as e:
            last_error = e
            if attempt < attempts - 1:
                print(f"[youtube] yt-dlp extract_info attempt {attempt + 1} failed, retrying: {e}", flush=True)
                await asyncio.sleep(1.5)
    print(f"[youtube] yt-dlp extract_info failed after {attempts} attempts: {last_error}", flush=True)
    return None

def _parse_youtube_caption_track(caption_json: dict) -> str:
    """Flatten a YouTube timedtext json3 caption payload into plain text."""
    events = caption_json.get("events", []) or []
    chunks = []
    for event in events:
        for seg in event.get("segs", []) or []:
            text = seg.get("utf8", "")
            if text:
                chunks.append(text)
    return " ".join("".join(chunks).replace("\n", " ").split())

async def _transcribe_youtube_via_gemini(url: str) -> str:
    """Fallback for a video with no caption track in any language — Gemini's native
    YouTube-URL ingestion watches/listens to the video directly with no download required.
    Verified directly against a real public video (see CLAUDE.md's video-support round).
    Used sparingly: only when captions are missing, since it's slower/costlier than parsing
    a caption file."""
    try:
        loop = asyncio.get_running_loop()
        response = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                lambda: gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=[
                        types.Content(role="user", parts=[
                            types.Part(file_data=types.FileData(file_uri=url)),
                            types.Part.from_text(
                                "Transcribe what is said in this video and describe what is "
                                "shown, including any on-screen text. Be concise but capture "
                                "the substance of the content."
                            )
                        ])
                    ],
                    config=_NO_THINKING
                )
            ),
            timeout=45.0
        )
        return response.text.strip()
    except Exception as e:
        print(f"[youtube] Gemini video-URL fallback failed: {e}", flush=True)
        return ""

async def fetch_youtube(url: str):
    """Real YouTube content extraction (see CLAUDE.md's video-support round): yt-dlp for
    metadata + captions, falling back to Gemini's native YouTube-URL video understanding
    when no caption track exists at all. Never raises — any failure degrades to empty
    strings so process_save can decide whether to bail to thin_content.
    Returns (title, author, transcript, thumbnail_url, description)."""
    info = await _extract_youtube_info_with_retry(url)
    if info is None:
        return "", "", "", "", ""

    title = info.get("title") or ""
    author = info.get("uploader") or info.get("channel") or ""
    thumbnail_url = info.get("thumbnail") or ""
    description = (info.get("description") or "")[:1000]

    transcript = ""
    subs = info.get("subtitles") or {}
    auto_subs = info.get("automatic_captions") or {}
    # Prefer a manual (creator-provided) transcript over an auto-generated one; prefer
    # English but fall back to whatever language is available rather than getting nothing.
    track_list = (subs.get("en") or auto_subs.get("en")
                  or next(iter(subs.values()), None) or next(iter(auto_subs.values()), None) or [])
    track = next((t for t in track_list if t.get("ext") == "json3"), None)
    if track:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                res = await safe_get(client, track["url"])
                transcript = _parse_youtube_caption_track(res.json())[:MAX_VIDEO_TRANSCRIPT_CHARS]
        except Exception as e:
            print(f"[youtube] caption fetch/parse failed: {e}", flush=True)

    if not transcript:
        transcript = await _transcribe_youtube_via_gemini(url)

    return title, author, transcript, thumbnail_url, description

_reddit_token_cache = {"token": None, "expires_at": 0}

async def _get_reddit_token() -> str:
    """App-only OAuth token (client_credentials grant) — cached in-process, refreshed when expired.
    Unlike X's static TWITTER_BEARER_TOKEN, Reddit tokens expire hourly and must be fetched ourselves."""
    if _reddit_token_cache["token"] and time.time() < _reddit_token_cache["expires_at"]:
        return _reddit_token_cache["token"]
    client_id = os.getenv("REDDIT_CLIENT_ID")
    client_secret = os.getenv("REDDIT_CLIENT_SECRET")
    if not client_id or not client_secret:
        return ""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(
                "https://www.reddit.com/api/v1/access_token",
                data={"grant_type": "client_credentials"},
                auth=(client_id, client_secret),
                headers={"User-Agent": os.getenv("REDDIT_USER_AGENT", "ReCall/1.0")},
            )
        if res.status_code != 200:
            print(f"[reddit-auth] non-200: {res.status_code} body={res.text[:200]!r}", flush=True)
            return ""
        data = res.json()
        _reddit_token_cache["token"] = data["access_token"]
        _reddit_token_cache["expires_at"] = time.time() + data.get("expires_in", 3600) - 60
        return _reddit_token_cache["token"]
    except Exception as e:
        print(f"[reddit-auth] exception: {e!r}", flush=True)
        return ""

REDDIT_COMMENT_SKIP_AUTHORS = {"AutoModerator"}
REDDIT_COMMENT_SKIP_BODIES = {"[deleted]", "[removed]"}

def _parse_reddit_listing(data):
    """Parse Reddit's comments-listing JSON shape — identical whether it came from the
    authenticated oauth.reddit.com API or the unauthenticated .json endpoint.
    Returns (title, body_text, subreddit, post_hint, image_url, comments_text)."""
    post = data[0]["data"]["children"][0]["data"]
    title = decode_html_entities(post.get("title", ""))
    body_text = decode_html_entities(post.get("selftext", "") or "")
    subreddit = post.get("subreddit_name_prefixed", "")
    post_hint = post.get("post_hint", "")
    image_url = ""
    if post_hint == "image":
        image_url = post.get("url_overridden_by_dest", "")
    else:
        images = (post.get("preview") or {}).get("images") or []
        if images:
            image_url = decode_html_entities(images[0].get("source", {}).get("url", ""))

    comments = []
    for child in (data[1]["data"]["children"] if len(data) > 1 else []):
        if child.get("kind") != "t1":
            continue
        c = child.get("data", {})
        body = c.get("body", "")
        author = c.get("author", "")
        if not body or body in REDDIT_COMMENT_SKIP_BODIES or author in REDDIT_COMMENT_SKIP_AUTHORS:
            continue
        comments.append(f"- {author}: {decode_html_entities(body)[:300]}")
        if len(comments) >= 5:
            break
    comments_text = ("Top comments:\n" + "\n".join(comments)) if comments else ""

    return title, body_text, subreddit, post_hint, image_url, comments_text

async def fetch_reddit(url: str):
    """Fetch a Reddit post + its top comments. Prefers Reddit's official OAuth API
    (oauth.reddit.com) when REDDIT_CLIENT_ID/SECRET are configured — Reddit now gates
    app registration behind manual approval ("Responsible Builder Policy"), so this is
    often unavailable. Falls back to the unauthenticated reddit.com/<path>.json endpoint,
    which needs no registration but rides Reddit's anti-bot tolerance rather than a
    sanctioned API (see Known Issue #30/#31) — still far more reliable than the plain
    HTML/Jina scrape this replaced, which got served a 'security check' interstitial.
    Returns (title, body_text, subreddit, post_hint, image_url, comments_text)."""
    # A generic/obviously-bot User-Agent (the "compatible; ReCall/1.0" string used elsewhere
    # in this file) gets an outright 403 from Reddit even on a plain redirect-resolution GET —
    # Reddit's anti-bot wall is exactly what this function exists to get around, so it needs a
    # genuinely realistic browser UA, same as fetch_instagram's embed fetch.
    browser_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        async with httpx.AsyncClient(timeout=12, headers=browser_headers) as client:
            # Resolve modern share shortlinks (reddit.com/r/<sub>/s/<token>, redd.it/<id>) to
            # the canonical /comments/<id>/ URL — needed by both the OAuth and .json paths.
            resolve_res = await safe_get(client, url)
            resolved_url = str(resolve_res.url)
            m = re.search(r'/comments/(\w+)', resolved_url)
            if not m:
                print(f"[reddit] could not extract post id url={url} resolved={resolved_url}", flush=True)
                return "", "", "", "", "", ""
            post_id = m.group(1)

            token = await _get_reddit_token()
            if token:
                res = await client.get(
                    f"https://oauth.reddit.com/comments/{post_id}",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": os.getenv("REDDIT_USER_AGENT", "ReCall/1.0"),
                    },
                )
            else:
                # www.reddit.com specifically blocks the .json suffix with a 403 even when
                # the plain HTML page next to it loads fine with the same headers — old.reddit.com
                # (the legacy UI domain) is consistently less aggressively bot-protected and still
                # serves the same .json data.
                old_url = re.sub(r'^https://(www\.)?reddit\.com', 'https://old.reddit.com', resolved_url)
                clean = old_url.split("?")[0].rstrip("/")
                res = await client.get(f"{clean}.json")

            if res.status_code != 200:
                via = "oauth" if token else "json"
                print(f"[reddit] non-200 via={via}: {res.status_code} body={res.text[:200]!r} url={url}", flush=True)
                return "", "", "", "", "", ""
            data = res.json()

        return _parse_reddit_listing(data)
    except Exception as e:
        print(f"[reddit] exception: {e!r} url={url}", flush=True)
        return "", "", "", "", "", ""

def _extract_tweet_id(tweet_url: str) -> str:
    m = re.search(r'/status/(\d+)', tweet_url)
    return m.group(1) if m else ""

async def _fetch_tweet_api(url: str) -> tuple[str, str, str]:
    """Official X API v2 tweet lookup (app-only Bearer token) — structured text/author/entities,
    replaces the legacy oEmbed scrape. entities.urls[].expanded_url already gives the unwound
    link behind any t.co, so callers don't need a separate redirect-follow for the common case."""
    bearer = os.getenv("TWITTER_BEARER_TOKEN")
    tweet_id = _extract_tweet_id(url)
    if not bearer or not tweet_id:
        return "", "", ""
    try:
        async with httpx.AsyncClient(timeout=10, headers={"Authorization": f"Bearer {bearer}"}) as client:
            res = await client.get(
                f"https://api.twitter.com/2/tweets/{tweet_id}",
                params={
                    "tweet.fields": "text,entities",
                    "expansions": "author_id",
                    "user.fields": "name",
                },
            )
        if res.status_code != 200:
            print(f"[tweet-api] non-200: {res.status_code} body={res.text[:200]!r} url={url}", flush=True)
            return "", "", ""
        data = res.json()
        tweet = data.get("data") or {}
        text = tweet.get("text", "")
        author = ((data.get("includes") or {}).get("users") or [{}])[0].get("name", "")
        urls = (tweet.get("entities") or {}).get("urls") or []
        expanded_url = next((u.get("expanded_url", "") for u in urls if u.get("expanded_url")), "")
        print(f"[tweet-api] success: text_len={len(text)} author={repr(author)} expanded_url={repr(expanded_url)} url={url}", flush=True)
        return text, author, expanded_url
    except Exception as e:
        print(f"[tweet-api] exception: {e!r} url={url}", flush=True)
        return "", "", ""

async def _fetch_tweet_card_title(tweet_url: str) -> str:
    """Twitter syndication API — returns tweet card title (article title for X Articles) without auth."""
    tweet_id = _extract_tweet_id(tweet_url)
    if not tweet_id:
        return ""
    try:
        val = math.floor(int(tweet_id) / 1e15 * math.pi)
        chars = "0123456789abcdefghijklmnopqrstuvwxyz"
        token = ""
        while val > 0:
            token = chars[int(val) % 36] + token
            val //= 36
        token = token or "0"
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
            res = await safe_get(
                client,
                "https://cdn.syndication.twimg.com/tweet-result",
                params={"id": tweet_id, "token": token, "lang": "en"},
            )
            data = res.json()
            article = data.get("article") or {}
            if article.get("title"):
                return article["title"], article.get("preview_text", "")
            bv = (data.get("card") or {}).get("binding_values") or {}
            return bv.get("title", {}).get("string_value", ""), ""
    except Exception as e:
        print(f"[syndication] exception: {e}", flush=True)
        return "", ""

X_JUNK_SIGNATURES = [
    # login-wall copy (logged-out fetches of gated tweets)
    "see what's happening", "continue with google", "continue with apple",
    "continue with phone", "by continuing, you agree to our terms of service",
    "don't miss what's happening", "log in to x", "sign-up to x", "sign up to x",
    # deleted/nonexistent-tweet 404 copy (X's own error page, not the tweet)
    "this page doesn't exist", "nothing to see here",
]

async def fetch_tweet(url: str):
    """X API v2 tweet lookup for structured text/author/entities; Jina Reader as enrichment
    for richer content (quoted tweets, linked previews) the plain tweet lookup doesn't carry."""
    (jina_text, jina_title), (api_text, author, expanded_url), og_html, (card_title, card_preview) = await asyncio.gather(
        fetch_with_jina(url),
        _fetch_tweet_api(url),
        fetch_og_html(url),
        _fetch_tweet_card_title(url)
    )
    og_title = extract_og_tags(og_html).get("og:title", "")
    if " on X" in og_title or og_title.endswith("on Twitter"):
        og_title = ""
    elif og_title and any(sig in og_title.lower() for sig in X_JUNK_SIGNATURES):
        # A plain unauthenticated fetch of an x.com/twitter.com URL can non-deterministically
        # be served X's own login/signup wall instead of the tweet — same failure mode as
        # jina_is_junk below, just against the OG title instead of the fetched body text.
        og_title = ""
    # Logged-out fetches of some tweets (e.g. /i/status/ links, or ones X otherwise
    # gates) get served X's own signup/login wall instead of the tweet, and deleted/
    # nonexistent tweets get served X's own 404 page — both are still >150 chars so
    # fetch_with_jina's length check doesn't catch them, and they were silently
    # overwriting real api_text/jina_title with X's own boilerplate.
    jina_is_junk = jina_text and any(sig in jina_text.lower() for sig in X_JUNK_SIGNATURES)
    if jina_is_junk:
        print(f"[tweet] jina login-wall/not-found signature detected, discarding jina content url={url}", flush=True)
        content = api_text
        jina_title = ""
    else:
        content = jina_text if len(jina_text) > len(api_text) else api_text
    if card_preview and len(card_preview) > len(content):
        content = card_preview
    return content, author, card_title or jina_title or og_title, expanded_url

async def fetch_with_jina(url: str) -> tuple[str, str]:
    """Fetch clean article content via Jina Reader (handles JS rendering, 'read more', etc).
    Returns (clean_text, title). Falls back to ("", "") on failure."""
    try:
        jina_headers = {
            "User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)",
            "X-Return-Format": "text",
        }
        jina_key = os.getenv("JINA_API_KEY")
        if jina_key:
            jina_headers["Authorization"] = f"Bearer {jina_key}"
        async with httpx.AsyncClient(timeout=15, headers=jina_headers) as client:
            res = await safe_get(client, f"https://r.jina.ai/{url}")
            if res.status_code != 200 or len(res.text) < 150:
                print(f"[jina] status={res.status_code} len={len(res.text)} body={res.text[:200]!r} url={url}", flush=True)
                return "", ""
            text = res.text
            # Extract title from Jina's output header (first few lines)
            title = ""
            content_start = 0
            for line in text.split('\n')[:8]:
                if line.startswith("Title:"):
                    title = line[6:].strip()
                elif line.startswith("Markdown Content:") or line.startswith("URL Source:"):
                    idx = text.find(line)
                    content_start = idx + len(line)
                    break
            content = text[content_start:].strip() if content_start else text
            return content[:5000], title
    except Exception as e:
        print(f"[jina] exception: {e!r} url={url}", flush=True)
        return "", ""

async def fetch_og_html(url: str) -> str:
    """Quick fetch of raw page HTML for OG tag + title extraction."""
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
            r = await safe_get(client, url)
            return r.text[:10000]
    except Exception:
        return ""

# Boilerplate that can appear even on a genuinely public, successfully-fetched Notion page
# (its "who can comment" widget) -- stripped as noise, never treated as a rejection signal.
NOTION_NOISE_PHRASES = [
    "Anyone with a Notion account can comment on this page.",
    "Sign up or login to comment",
]

# Phrases unique to Notion's login-wall shell (a page the anonymous fetcher isn't authorized
# to view) -- confirmed directly against a live authwalled page, whose entire fetched content
# is this boilerplate plus generic auth-provider button labels, long enough to clear
# QUALITY_THRESHOLD and marketing-flavored enough ("What is Notion?") that Gemini will
# otherwise synthesize a confident-but-wrong title from it. Kept deliberately separate from
# NOTION_NOISE_PHRASES above, whose phrases can appear on an otherwise-real public page.
NOTION_AUTHWALL_SIGNATURES = [
    "you're almost there",
    "sign in to see this page",
]

async def fetch_notion(url: str) -> tuple[str, bool]:
    """Fetch a public Notion page's real content via Jina Reader. A plain non-Jina fetch of a
    Notion URL (what fetch_og_html() would do) hits a redirect loop and fails outright --
    confirmed directly against live URLs -- so fetch_og_html is deliberately never called here.
    jina_title from fetch_with_jina() is always empty for Notion (ReCall requests
    X-Return-Format: text from Jina, which omits the header lines that title is parsed from)
    and is intentionally discarded -- the real title is derived from clean_text via the
    shared extract_save_metadata_async() tail, same as Instagram's raw_title pattern.
    Returns (clean_text, is_authwalled): clean_text is "" on outright fetch failure or when
    the login-wall signature fires; is_authwalled distinguishes the two for the caller's
    fallback message."""
    jina_text, _ = await fetch_with_jina(url)
    if not jina_text:
        print(f"[notion] jina fetch failed/empty url={url}", flush=True)
        return "", False
    normalized = jina_text.lower().replace("’", "'").replace("‘", "'")
    if any(sig in normalized for sig in NOTION_AUTHWALL_SIGNATURES):
        print(f"[notion] authwall signature detected, discarding url={url}", flush=True)
        return "", True
    clean_text = jina_text
    for noise in NOTION_NOISE_PHRASES:
        clean_text = clean_text.replace(noise, "")
    clean_text = re.sub(r'\s{2,}', ' ', clean_text).strip()
    return clean_text, False

async def resolve_linkedin_redirect(url: str) -> str:
    """Resolve LinkedIn's safety/go wrapper (and the lnkd.in interstitial behind it)
    to the actual destination URL. Returns the original url on any failure."""
    if "linkedin.com/safety/go" not in url:
        return url
    try:
        params = parse_qs(urlparse(url).query)
        target = params.get("url", [""])[0]
        if not target:
            return url
        # `target` is fully attacker-controlled (a query param off a public, unauthenticated
        # link) — validate it before firing any request, not after. A bare try/except around
        # the whole function previously let this fetch happen unconditionally and only
        # checked the *result*, which still means the SSRF request itself already fired.
        async with httpx.AsyncClient(timeout=8,
                headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
            r = await safe_get(client, target)
            resolved = str(r.url)
        # lnkd.in shortlinks return a 200 "this link isn't on LinkedIn"
        # interstitial instead of an HTTP redirect, so follow_redirects never
        # reaches the real destination — it's embedded in the page's
        # external_url_click anchor instead.
        if "lnkd.in" in resolved or "linkedin.com" in resolved:
            m = re.search(r'external_url_click"[^>]*href="([^"]+)"', r.text)
            if m:
                resolved = html_entities.unescape(m.group(1))
        if not await asyncio.to_thread(is_safe_url, resolved):
            return url
        return resolved
    except Exception:
        return url

async def _finalize_placeholder(placeholder_id: str | None, user_id: str | None = None,
                                 url: str | None = None, title: str | None = None):
    """Flip a pending placeholder row to 'ready', optionally overwriting its title — used when
    enrichment bails out early (thin content / authwall) so the row never stays stuck pending.
    Also sends the save-ready push here, mirroring the success path's call — otherwise a save
    that bails out early (thin content, authwall) finishes silently with no signal to the user,
    on top of whatever generic title it's left with."""
    if not placeholder_id:
        return
    payload = {"status": "ready"}
    if title:
        payload["title"] = title
    try:
        await _exec(supabase.table("saves").update(payload).eq("id", placeholder_id))
    except Exception:
        return
    if user_id and url:
        await send_save_ready_push(user_id, title or get_source_label(url), get_source_label(url))

async def process_save_preview(url: str) -> dict:
    """Read-only version of the save enrichment pipeline for logged-out previews.
    It intentionally performs no embedding or database writes, but uses the same fetchers
    and Gemini metadata extraction that a real saved row uses once enrichment finishes."""
    url = await resolve_linkedin_redirect(url)

    for pattern, ctype, label in MEDIA_URLS:
        if pattern in url:
            if "youtube.com" in url or "youtu.be" in url:
                yt_title, yt_author = await fetch_youtube(url)
                raw_title = f"{yt_title} · {yt_author}" if yt_title and yt_author else (yt_title or url)
            else:
                try:
                    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                        r = await safe_get(client, url)
                        og = extract_og_tags(r.text[:5000])
                        raw_title = og.get("og:title") or url
                except:
                    raw_title = url
            _, tag = await extract_save_metadata_async(raw_title, "", "")
            return {
                "success": True, "media": True, "content_type": ctype,
                "label": label, "title": raw_title, "tag": tag, "url": url,
                "content_text": f"{label} saved from {get_source_label(url)}.",
            }

    is_tweet = "x.com" in url or "twitter.com" in url
    is_instagram = "instagram.com" in url
    is_linkedin = "linkedin.com" in url
    is_reddit = "reddit.com" in url or "redd.it" in url
    is_notion = "notion.so" in url or "notion.site" in url or "app.notion.com" in url
    extra_context = ""

    if is_tweet:
        clean_text, tweet_author, jina_title, expanded_url = await fetch_tweet(url)
        article_title = ""
        if expanded_url and is_safe_url(expanded_url):
            try:
                final_url = expanded_url
                final_html = ""
                if "t.co/" in final_url:
                    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                        r = await safe_get(client, final_url)
                        final_url = str(r.url)
                        final_html = r.text[:5000]
                if "x.com/i/article/" in final_url or "twitter.com/i/article/" in final_url:
                    (article_jina_text, article_jina_title), article_og_html = await asyncio.gather(
                        fetch_with_jina(final_url),
                        fetch_og_html(final_url)
                    )
                    article_og_title = extract_og_tags(article_og_html).get("og:title", "")
                    article_is_js_disabled = any(
                        sig in article_jina_text.lower()
                        for sig in ["javascript is not available", "javascript is disabled"]
                    )
                    if article_jina_text and not article_is_js_disabled:
                        clean_text = article_jina_text
                    article_title = article_og_title or article_jina_title
                elif "twitter.com" not in final_url and "x.com" not in final_url:
                    if not final_html:
                        final_html = await fetch_og_html(final_url)
                    article_title = extract_og_tags(final_html).get("og:title", "")
            except Exception:
                pass
        stub_only = not clean_text or clean_text.strip().startswith("https://t.co/") or len(clean_text) < 80
        title = article_title or jina_title or (clean_text[:100].strip() if not stub_only else "") or tweet_author or url
        if title == url:
            return {"thin_content": True, "url": url}
        if tweet_author:
            extra_context = f"Author: {tweet_author}"
    elif is_instagram:
        caption, author, thumbnail_url = await fetch_instagram(url)
        clean_text = caption
        title = author or "Instagram"
        if thumbnail_url and len(clean_text) < 400:
            image_description = await analyze_image(thumbnail_url)
            if image_description:
                extra_context = f"Image: {image_description}"
                clean_text = (clean_text + "\n\n" + extra_context).strip()
    elif is_linkedin:
        raw_html = await fetch_og_html(url)
        og = extract_og_tags(raw_html)
        og_title = og.get("og:title", "")
        og_description = og.get("og:description", "") or og.get("description", "")
        authwall_signatures = [
            "agree & join linkedin", "login to linkedin to keep in touch",
            "by clicking continue to join or sign in", "new to linkedin? join now",
            "skip to main content", "linkedin login, sign in",
        ]
        combined = og_description or ""
        for noise in ["Like · Comment · Share", "Like Comment Share", "1st · ", "2nd · ",
                      "3rd · ", "Connect", "Follow", "Message", "View all comments",
                      "Load more comments", "Sign in to view", "Join now to see"]:
            combined = combined.replace(noise, "")
        clean_text = re.sub(r'\s{2,}', ' ', combined).strip()
        title = og_title or url
        lowered = (clean_text + " " + og_title).lower()
        if any(sig in lowered for sig in authwall_signatures):
            return {"thin_content": True, "url": url}
        linkedin_quality_threshold = 40
        if len(clean_text.strip()) < linkedin_quality_threshold and og_title:
            fallback_text = re.sub(r'\s*\|\s*\d+\s+comments?\s*$', '', og_title, flags=re.IGNORECASE)
            fallback_text = re.sub(r'\s*\|\s*[^|]+$', '', fallback_text).strip()
            if len(fallback_text) >= linkedin_quality_threshold:
                clean_text = fallback_text
        if len(clean_text.strip()) < linkedin_quality_threshold:
            return {"thin_content": True, "url": url}
    elif is_reddit:
        title, body_text, subreddit, _post_hint, image_url, comments_text = await fetch_reddit(url)
        if not title:
            return {"thin_content": True, "url": url}
        clean_text = body_text
        extra_context = f"Subreddit: {subreddit}" if subreddit else ""
        if image_url and len(clean_text) < 200:
            image_description = await analyze_image(image_url)
            if image_description:
                extra_context = (extra_context + f"\nImage: {image_description}").strip()
                clean_text = (clean_text + "\n\n" + image_description).strip()
        if comments_text:
            extra_context = (extra_context + f"\n\n{comments_text}").strip()
            clean_text = (clean_text + "\n\n" + comments_text).strip()
    elif is_notion:
        clean_text, _ = await fetch_notion(url)
        if len(clean_text.strip()) < QUALITY_THRESHOLD:
            return {"thin_content": True, "url": url}
        title = "Notion"
    else:
        (jina_text, jina_title), raw_html = await asyncio.gather(
            fetch_with_jina(url),
            fetch_og_html(url)
        )
        title_match = re.search(r'<title>(.*?)</title>', raw_html, re.IGNORECASE)
        html_title = decode_html_entities(title_match.group(1)) if title_match else ""
        og = extract_og_tags(raw_html)
        og_title = og.get("og:title", "")
        og_description = og.get("og:description", "") or og.get("description", "")
        og_image = og.get("og:image", "")
        if jina_text:
            clean_text = jina_text
            title = jina_title or og_title or html_title or url
        else:
            from html.parser import HTMLParser
            class TextExtractor(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.text = []
                    self.in_script = False
                def handle_starttag(self, tag, attrs):
                    if tag in ['script', 'style']:
                        self.in_script = True
                def handle_endtag(self, tag):
                    if tag in ['script', 'style']:
                        self.in_script = False
                def handle_data(self, data):
                    if not self.in_script:
                        self.text.append(data.strip())
            parser = TextExtractor()
            parser.feed(raw_html)
            clean_text = " ".join(t for t in parser.text if t)[:5000]
            title = og_title or html_title or url
        if og_title and (not title or title == url):
            title = og_title
        extra_parts = []
        if og_description:
            extra_parts.append(og_description)
        if og_image and len(clean_text) < 400:
            image_description = await analyze_image(og_image)
            if image_description:
                extra_parts.append(f"Image: {image_description}")
        extra_context = "\n".join(extra_parts)
        if extra_context:
            clean_text = (clean_text + "\n\n" + extra_context)[:5000]
        if len((clean_text + extra_context).strip()) < QUALITY_THRESHOLD:
            return {"thin_content": True, "url": url}

    title, tag = await extract_save_metadata_async(title, clean_text, extra_context)
    return {
        "success": True,
        "title": title,
        "tag": tag,
        "url": url,
        "content_text": clean_text,
        "content_type": "article",
    }


async def process_save(url: str, user_id: str, placeholder_id: str | None = None) -> dict:
    """Core save pipeline shared by /save's background enrichment, the bookmark import job,
    and the recall_save MCP tool.
    Returns one of:
      {"duplicate": True, "id", "title", "tag", "created_at"}
      {"thin_content": True, "url"}
      {"success": True, "media": True, "content_type", "label", "title", "tag", "id"}
      {"success": True, "title", "tag", "id", "related_ids"}
      {"error": True, "url", "detail"}
    Never raises for save-pipeline-internal failures — but get_embedding can still raise
    HTTPException (503) on a Gemini outage; callers should be prepared to catch that too.

    `placeholder_id`: when set, this is enriching a row inserted by `process_save_fast` —
    skip the duplicate check (already done) and UPDATE that row instead of inserting a new one.
    """
    url = await resolve_linkedin_redirect(url)
    if "linkedin.com/safety/go" in url:
        # resolve_linkedin_redirect couldn't actually resolve this wrapper (the fetch of
        # its target failed) and handed back the unresolved wrapper itself — proceeding
        # would save LinkedIn's own interstitial page as if it were the article.
        await _finalize_placeholder(placeholder_id, user_id, url)
        return {"thin_content": True, "url": url}
    await validate_url(url)

    if not placeholder_id:
        existing = await _exec(supabase.table("saves")
            .select("id, title, tag, created_at")
            .eq("user_id", user_id).eq("url", url)
            .limit(1))
        if existing.data:
            row = existing.data[0]
            return {"duplicate": True, "id": row["id"], "title": row["title"],
                    "tag": row["tag"], "created_at": row["created_at"]}

    # --- Media URL classification (content_type only) ---
    media_ctype, media_label = None, None
    for pattern, ctype, label in MEDIA_URLS:
        if pattern in url:
            media_ctype, media_label = ctype, label
            break

    # TikTok stays on the old thin oEmbed-less short-circuit: both a plain scrape and
    # yt-dlp were confirmed via direct testing to fail outright from cloud/datacenter IPs
    # without user-supplied login cookies — the same class of infra Railway hosts on — so
    # this round's real content-extraction pipeline (YouTube/Instagram below) isn't applied
    # here. Revisit only once TikTok fetches are confirmed working live on Railway.
    if "tiktok.com" in url:
        try:
            async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                r = await safe_get(client, url)
                og = extract_og_tags(r.text[:5000])
                raw_title = og.get("og:title") or url
        except:
            raw_title = url
        embedding = await get_embedding(raw_title)
        _, tag = await extract_save_metadata_async(raw_title, "", "")
        payload = {
            "user_id": user_id, "url": url, "title": raw_title,
            "content_text": "", "embedding": embedding, "tag": tag,
            "content_type": media_ctype, "status": "ready"
        }
        try:
            if placeholder_id:
                await _exec(supabase.table("saves").update(payload).eq("id", placeholder_id))
                inserted_id = placeholder_id
            else:
                try:
                    result = await _exec(supabase.table("saves").insert(payload))
                except APIError as e:
                    # A concurrent save of this URL won the race against the duplicate
                    # check above (recall_core.py, this function's `if not placeholder_id`
                    # block) — the saves_user_id_url_key constraint (sql/012) turns that
                    # into a clean 23505 instead of a silent duplicate row.
                    if e.code != "23505":
                        raise
                    return await _duplicate_response(user_id, url)
                inserted_id = result.data[0]["id"]
        except Exception as e:
            print(f"[media save] DB insert failed: {e}", flush=True)
            return {"error": True, "url": url, "detail": "DB insert failed"}
        if placeholder_id:
            await send_save_ready_push(user_id, raw_title, get_source_label(url))
        return {"success": True, "media": True, "content_type": media_ctype,
                "label": media_label, "title": raw_title, "tag": tag, "id": inserted_id}

    is_youtube = "youtube.com" in url or "youtu.be" in url
    is_tweet = "x.com" in url or "twitter.com" in url
    is_instagram = "instagram.com" in url
    is_linkedin = "linkedin.com" in url
    is_reddit = "reddit.com" in url or "redd.it" in url
    is_notion = "notion.so" in url or "notion.site" in url or "app.notion.com" in url

    extra_context = ""
    content_type = "article"
    thumbnail_url = None

    if is_youtube:
        yt_title, yt_author, transcript, yt_thumbnail, description = await fetch_youtube(url)
        if not yt_title and not transcript:
            # yt-dlp couldn't get anything at all — video is private/deleted/region-blocked
            # with no recoverable content, same treatment as an unfetchable tweet.
            await _finalize_placeholder(placeholder_id, user_id, url)
            return {"thin_content": True, "url": url}
        title = f"{yt_title} · {yt_author}" if yt_title and yt_author else (yt_title or url)
        clean_text = transcript
        extra_context = description
        content_type = media_ctype or "video"
        thumbnail_url = yt_thumbnail or None
    elif is_tweet:
        clean_text, tweet_author, jina_title, expanded_url = await fetch_tweet(url)
        print(f"[tweet] author={repr(tweet_author)} jina_title={repr(jina_title)} expanded_url={repr(expanded_url)} clean_text_len={len(clean_text)} clean_text_preview={repr(clean_text[:150])}", flush=True)
        article_title = ""
        if expanded_url and is_safe_url(expanded_url):
            try:
                final_url = expanded_url
                final_html = ""
                if "t.co/" in final_url:
                    # API gave no resolved entity (rare) — fall back to following the raw t.co link
                    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                        r = await safe_get(client, final_url)
                        final_url = str(r.url)
                        final_html = r.text[:5000]
                if "x.com/i/article/" in final_url or "twitter.com/i/article/" in final_url:
                    # X Article — try OG tags and Jina in parallel
                    (article_jina_text, article_jina_title), article_og_html = await asyncio.gather(
                        fetch_with_jina(final_url),
                        fetch_og_html(final_url)
                    )
                    article_og_title = extract_og_tags(article_og_html).get("og:title", "")
                    if article_og_title and any(sig in article_og_title.lower() for sig in X_JUNK_SIGNATURES):
                        # Same login-wall risk as fetch_tweet()'s own og_title check — this
                        # article_og_title had no junk filtering at all, so a login-walled
                        # fetch of the expanded X Article URL could silently win the
                        # `article_title or jina_title or ...` chain below over an already-good
                        # title (e.g. "Login/Sign-up to X Corp." overriding a real tweet title).
                        article_og_title = ""
                    # x.com's article pages often render as a "JavaScript is disabled" noscript
                    # interstitial when Jina can't execute the page's JS — that's still >150 chars
                    # so fetch_with_jina's own length check doesn't catch it, and it was silently
                    # overwriting the original tweet's already-good clean_text with boilerplate.
                    js_disabled_signatures = ["javascript is not available", "javascript is disabled"]
                    article_is_js_disabled = any(sig in article_jina_text.lower() for sig in js_disabled_signatures)
                    # Same login-wall risk as fetch_tweet()'s own jina_is_junk check — a
                    # login-walled fetch of the expanded X Article URL discards both the
                    # text and title together, since they come from the same page fetch.
                    article_jina_is_junk = article_jina_text and any(sig in article_jina_text.lower() for sig in X_JUNK_SIGNATURES)
                    if article_jina_is_junk:
                        article_jina_title = ""
                    if article_jina_text and not article_is_js_disabled and not article_jina_is_junk:
                        clean_text = article_jina_text
                    article_title = article_og_title or article_jina_title
                    print(f"[tweet] X Article — og_title={repr(article_og_title)} jina_title={repr(article_jina_title)} js_disabled={article_is_js_disabled} content_len={len(clean_text)}", flush=True)
                elif "twitter.com" not in final_url and "x.com" not in final_url:
                    if not final_html:
                        final_html = await fetch_og_html(final_url)
                    og = extract_og_tags(final_html)
                    article_title = og.get("og:title", "")
                    print(f"[tweet] external link — final_url={repr(final_url)} article_title={repr(article_title)}", flush=True)
            except Exception as e:
                print(f"[tweet] expanded_url resolution failed: {e}", flush=True)
        stub_only = not clean_text or clean_text.strip().startswith("https://t.co/") or len(clean_text) < 80
        title = article_title or jina_title or (clean_text[:100].strip() if not stub_only else "") or tweet_author or url
        if title == url:
            # Nothing usable came back at all (deleted/protected/unfetchable tweet) — skip
            # rather than insert a row whose only "title" is the URL itself.
            await _finalize_placeholder(placeholder_id, user_id, url)
            return {"thin_content": True, "url": url}
        if tweet_author:
            extra_context = f"Author: {tweet_author}"
        print(f"[tweet] final title passed to extract_save_metadata: {repr(title)}", flush=True)
    elif is_instagram:
        # Real caption text (see CLAUDE.md's video-support round) — previously this branch
        # was unreachable for /reel/ and /p/ URLs, which got intercepted by the media loop
        # above and saved with content_text="". Full video/audio transcription isn't
        # attempted: confirmed directly that yt-dlp's Instagram video-download path requires
        # user-supplied login cookies, and the embed page's thumbnail is CDN-hotlink-blocked
        # (403 even with a Referer header) — so there's no thumbnail to run vision analysis
        # on either. Caption text is the real, achievable content for now.
        caption, author, _ig_thumb = await fetch_instagram(url)
        clean_text = caption
        title = author or "Instagram"
        content_type = media_ctype or "article"
    elif is_linkedin:
        # Jina Reader was tried here for "See more" expansion, but LinkedIn's anonymous-access
        # authwall blocks it almost every time in practice (either an explicit authwall page or
        # a 15s ReadTimeout) — pure latency with no realized benefit, since og:description (and
        # the og:title fallback below) already carry the real post content. Dropped to cut the
        # slowest leg out of LinkedIn save latency.
        raw_html = await fetch_og_html(url)
        og = extract_og_tags(raw_html)
        og_title = og.get("og:title", "")
        og_description = og.get("og:description", "") or og.get("description", "")

        # LinkedIn's anonymous-access login wall returns generic marketing copy in
        # og:description sometimes — check for it before trusting og_description as the body.
        AUTHWALL_SIGNATURES = [
            "agree & join linkedin", "login to linkedin to keep in touch",
            "by clicking continue to join or sign in", "new to linkedin? join now",
            "skip to main content", "linkedin login, sign in",
        ]

        combined = og_description if og_description else ""

        # Strip LinkedIn UI boilerplate
        for noise in ["Like · Comment · Share", "Like Comment Share", "1st · ", "2nd · ",
                      "3rd · ", "Connect", "Follow", "Message", "View all comments",
                      "Load more comments", "Sign in to view", "Join now to see"]:
            combined = combined.replace(noise, "")
        clean_text = re.sub(r'\s{2,}', ' ', combined).strip()

        title = og_title or url
        print(f"[linkedin] og_title={og_title!r} og_description_len={len(og_description)} clean_text_len={len(clean_text)} clean_text_preview={clean_text[:150]!r} url={url}", flush=True)
        lowered = (clean_text + " " + og_title).lower()
        if any(sig in lowered for sig in AUTHWALL_SIGNATURES):
            print(f"[linkedin] authwall signature detected, skipping url={url}", flush=True)
            await _finalize_placeholder(placeholder_id, user_id, url)
            return {"thin_content": True, "url": url}
        # LinkedIn posts are often short (a one-liner, a quote) — use a lower bar than the
        # generic article threshold, since the authwall check above already filters garbage.
        LINKEDIN_QUALITY_THRESHOLD = 40
        if len(clean_text.strip()) < LINKEDIN_QUALITY_THRESHOLD and og_title:
            # og_description sometimes comes back empty/truncated even though LinkedIn
            # already embedded the full post text in og:title, suffixed with
            # "| Author Name | N comments" — strip that suffix and use it as the body.
            fallback_text = re.sub(r'\s*\|\s*\d+\s+comments?\s*$', '', og_title, flags=re.IGNORECASE)
            fallback_text = re.sub(r'\s*\|\s*[^|]+$', '', fallback_text).strip()
            if len(fallback_text) >= LINKEDIN_QUALITY_THRESHOLD:
                clean_text = fallback_text
        if len(clean_text.strip()) < LINKEDIN_QUALITY_THRESHOLD:
            await _finalize_placeholder(placeholder_id, user_id, url)
            return {"thin_content": True, "url": url}
    elif is_reddit:
        title, body_text, subreddit, post_hint, image_url, comments_text = await fetch_reddit(url)
        print(f"[reddit] title={repr(title)} subreddit={repr(subreddit)} post_hint={repr(post_hint)} body_len={len(body_text)} has_image={bool(image_url)} comments_len={len(comments_text)} url={url}", flush=True)
        if not title:
            # Fetch failed entirely (creds missing/blocked/deleted/private). Reddit currently
            # blocks every unauthenticated path we have (see Known Issue #30/#31) -- rather
            # than leave a bare, ambiguous "Reddit" title sitting in the list, tell the user
            # directly so they know to set their own (the receipt card's pencil-icon edit
            # already supports this for any save).
            await _finalize_placeholder(
                placeholder_id, user_id, url,
                title="Tap to add your own title [Reddit auto-titling isn't available yet]",
            )
            return {"thin_content": True, "url": url}
        clean_text = body_text
        extra_context = f"Subreddit: {subreddit}" if subreddit else ""
        # Image/link posts often have little or no selftext — fall back to vision analysis,
        # same pattern as Instagram's sparse-caption fallback
        if image_url and len(clean_text) < 200:
            image_description = await analyze_image(image_url)
            if image_description:
                extra_context = (extra_context + f"\nImage: {image_description}").strip()
                clean_text = (clean_text + "\n\n" + image_description).strip()
        # Comments are the point for Reddit — fold the top discussion into both the embedded
        # text and the Gemini context so search/tagging account for the discussion, not just the post
        if comments_text:
            extra_context = (extra_context + f"\n\n{comments_text}").strip()
            clean_text = (clean_text + "\n\n" + comments_text).strip()
    elif is_notion:
        clean_text, was_authwalled = await fetch_notion(url)
        print(f"[notion] authwalled={was_authwalled} clean_text_len={len(clean_text)} url={url}", flush=True)
        if len(clean_text.strip()) < QUALITY_THRESHOLD:
            fallback_title = (
                "Tap to add your own title [this Notion page requires login to view]"
                if was_authwalled else
                "Tap to add your own title [Notion auto-titling isn't available yet]"
            )
            await _finalize_placeholder(placeholder_id, user_id, url, title=fallback_title)
            return {"thin_content": True, "url": url}
        title = "Notion"
    else:
        # Run Jina Reader and raw OG fetch concurrently for speed
        (jina_text, jina_title), raw_html = await asyncio.gather(
            fetch_with_jina(url),
            fetch_og_html(url)
        )

        title_match = re.search(r'<title>(.*?)</title>', raw_html, re.IGNORECASE)
        html_title = decode_html_entities(title_match.group(1)) if title_match else ""
        og = extract_og_tags(raw_html)
        og_title = og.get("og:title", "")
        og_description = og.get("og:description", "") or og.get("description", "")
        og_image = og.get("og:image", "")

        if jina_text:
            # Jina succeeded — use its clean rendered content
            clean_text = jina_text
            title = jina_title or og_title or html_title or url
        else:
            # Jina failed — fall back to HTML parse of raw page
            from html.parser import HTMLParser
            class TextExtractor(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.text = []
                    self.in_script = False
                def handle_starttag(self, tag, attrs):
                    if tag in ['script', 'style']:
                        self.in_script = True
                def handle_endtag(self, tag):
                    if tag in ['script', 'style']:
                        self.in_script = False
                def handle_data(self, data):
                    if not self.in_script:
                        self.text.append(data.strip())
            parser = TextExtractor()
            parser.feed(raw_html)
            clean_text = " ".join(t for t in parser.text if t)[:5000]
            title = og_title or html_title or url

        # Prefer og:title when current title is generic
        if og_title and (not title or title == url):
            title = og_title

        # Build extra context: OG description + vision analysis for sparse pages
        extra_parts = []
        if og_description:
            extra_parts.append(og_description)
        if og_image and len(clean_text) < 400:
            image_description = await analyze_image(og_image)
            if image_description:
                extra_parts.append(f"Image: {image_description}")
        extra_context = "\n".join(extra_parts)

        if extra_context:
            clean_text = (clean_text + "\n\n" + extra_context)[:5000]

        if len((clean_text + extra_context).strip()) < QUALITY_THRESHOLD:
            await _finalize_placeholder(placeholder_id, user_id, url)
            return {"thin_content": True, "url": url}

    title, tag = await extract_save_metadata_async(title, clean_text, extra_context)
    topics = await extract_topics_async(title, clean_text, extra_context)
    embedding = await get_embedding(f"{title} {clean_text}")
    topic_embedding = await get_embedding(topics, task_type="RETRIEVAL_DOCUMENT") if topics else None

    payload = {
        "user_id": user_id, "url": url, "title": title,
        "content_text": clean_text, "embedding": embedding, "tag": tag,
        "topics": topics, "topic_embedding": topic_embedding,
        "content_type": content_type, "status": "ready", "thumbnail_url": thumbnail_url
    }
    try:
        if placeholder_id:
            await _exec(supabase.table("saves").update(payload).eq("id", placeholder_id))
            inserted_id = placeholder_id
        else:
            try:
                result = await _exec(supabase.table("saves").insert(payload))
            except APIError as e:
                # Same race as the media-save branch above — a concurrent save of this URL
                # landed after this function's own duplicate check but before this insert.
                if e.code != "23505":
                    raise
                return await _duplicate_response(user_id, url)
            inserted_id = result.data[0]["id"]
    except Exception as e:
        print(f"[save] DB insert failed: {e}", flush=True)
        return {"error": True, "url": url, "detail": "DB insert failed"}

    # Find semantically related saves and store cross-references (best-effort)
    related_ids = []
    try:
        related_result = await _exec(supabase.rpc("find_related_saves", {
            "save_embedding": embedding,
            "exclude_id": inserted_id,
            "match_user_id": user_id,
            "match_count": 3
        }))
        related_ids = [r["id"] for r in (related_result.data or [])]
        if related_ids:
            await _exec(supabase.table("saves").update({"related_ids": related_ids})
                .eq("id", inserted_id))
    except Exception:
        pass  # Silently skip if RPC/column not yet set up in Supabase

    if placeholder_id:
        await send_save_ready_push(user_id, title, get_source_label(url))
    return {"success": True, "title": title, "tag": tag, "id": inserted_id, "related_ids": related_ids}

async def process_save_fast(url: str, user_id: str) -> dict:
    """Fast path for the interactive REST /save flow: do only the cheap synchronous work
    (LinkedIn redirect resolution, duplicate check, a no-network media-type guess), insert
    a 'pending' placeholder row, and return immediately. The expensive page-fetch/Gemini
    pipeline runs in the background via process_save() and updates the row when done.
    Bookmark import and the MCP recall_save tool intentionally skip this — they call
    process_save() directly and keep today's fully-synchronous behavior."""
    url = await resolve_linkedin_redirect(url)

    content_type, label = "article", None
    for pattern, ctype, lbl in MEDIA_URLS:
        if pattern in url:
            content_type, label = ctype, lbl
            break

    placeholder_title = get_source_label(url)
    try:
        # INSERT ... ON CONFLICT (user_id, url) DO NOTHING in one round-trip, replacing
        # the old always-SELECT-then-INSERT (two round-trips on every save). An empty
        # result.data means the row already existed (conflict) — only then do we pay a
        # second round-trip, to fetch that existing row's details for the duplicate
        # response. See sql/012_saves_unique_user_url.sql for the backing constraint.
        result = await _exec(supabase.table("saves").upsert({
            "user_id": user_id, "url": url, "title": placeholder_title,
            "content_text": "", "embedding": None, "tag": None,
            "content_type": content_type, "status": "pending"
        }, on_conflict="user_id,url", ignore_duplicates=True))
    except Exception as e:
        print(f"[save_fast] DB insert failed: {e}", flush=True)
        return {"error": True, "url": url, "detail": "DB insert failed"}

    if not result.data:
        return await _duplicate_response(user_id, url)

    placeholder_id = result.data[0]["id"]
    asyncio.create_task(_enrich_in_background(url, user_id, placeholder_id))
    return {"success": True, "pending": True, "id": placeholder_id,
            "title": placeholder_title, "url": url, "content_type": content_type, "label": label}

async def _enrich_in_background(url: str, user_id: str, placeholder_id: str):
    try:
        await process_save(url, user_id, placeholder_id=placeholder_id)
    except Exception as e:
        print(f"[enrich] background save failed for {placeholder_id}: {e}", flush=True)
        await _finalize_placeholder(placeholder_id, user_id, url)

NEWSLETTER_QUALITY_THRESHOLD = 40  # chars — newsletters are often short, same bar as LinkedIn posts

async def _find_user_id_by_email(email: str) -> str | None:
    """Look up a Supabase auth user by email via the admin API — there's no email->user_id
    table in this schema otherwise. Paginates through all users; fine at this app's scale,
    but would need a dedicated index/table if the user base grew large."""
    if not email:
        return None
    email = email.strip().lower()
    try:
        page = 1
        while True:
            resp = await asyncio.to_thread(supabase.auth.admin.list_users, page=page, per_page=200)
            users = resp if isinstance(resp, list) else getattr(resp, "users", [])
            if not users:
                return None
            for u in users:
                if (getattr(u, "email", "") or "").strip().lower() == email:
                    return u.id
            if len(users) < 200:
                return None
            page += 1
    except Exception as e:
        print(f"[newsletter] user lookup failed: {e!r}", flush=True)
        return None

def _resolve_forwarding_sender(headers: dict) -> str:
    """Figure out which email address actually forwarded this message into ReCall.
    Gmail filter-based auto-forwarding adds 'X-Forwarded-For: <forwarding mailbox> <destination>' —
    the FIRST address is the Gmail account that owns the filter, NOT the newsletter's original
    sender. This must be checked before falling back to the From header, otherwise auto-forwarded
    mail tries to match the newsletter's own sender address and never resolves to a user.
    Manual forwards (clicking "Forward" in Gmail) don't get this header — the From header is
    already the user's own address in that case, so the fallback covers it."""
    forwarded_for = headers.get("x_forwarded_for") or headers.get("x-forwarded-for") or ""
    if forwarded_for:
        first = forwarded_for.split()[0].strip()
        m = re.search(r'[\w.+-]+@[\w-]+\.[\w.-]+', first)
        if m:
            return m.group(0)
    from_header = headers.get("from") or ""
    m = re.search(r'[\w.+-]+@[\w-]+\.[\w.-]+', from_header)
    return m.group(0) if m else ""

def _html_to_text(html: str) -> str:
    """Newsletter HTML (Substack/Beehiiv/ConvertKit templates) is heavier/messier than the
    cases the stdlib HTMLParser elsewhere in this file was built for — BeautifulSoup handles
    nested tables/styling far more reliably."""
    if not html:
        return ""
    try:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "head"]):
            tag.decompose()
        # Gmail wraps the "---------- Forwarded message ---------" + From/Date/Subject/To block
        # in a `gmail_attr` div. Removing it here (before flattening to text) sidesteps the header
        # fields getting split across multiple lines below whenever a value (sender/recipient) is
        # a mailto link — get_text()'s separator has no way to know those fragments shared one
        # visual line, which is what broke the text-regex-only approach this replaces.
        for tag in soup.find_all(class_="gmail_attr"):
            tag.decompose()
        text = soup.get_text(separator="\n")
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        return "\n".join(lines)[:5000]
    except Exception:
        return ""

_FORWARD_MARKER_RE = re.compile(r'-{2,}\s*Forwarded message\s*-{2,}\s*\n', re.IGNORECASE)
# Tried in order: whichever header field is last present wins, so the block is stripped through
# its true end even when an earlier field's label and value land on separate lines (e.g. "From:"
# and the sender's name/email get split onto two lines when the name is a link in the source
# HTML, which get_text()'s "\n" separator doesn't know is the same visual line).
_FORWARD_END_ANCHORS = ("To", "Subject", "Date", "From")

def _strip_forwarded_header(text: str) -> str:
    """Gmail's 'Forward' action prepends a '---------- Forwarded message ---------' block with
    From/Date/Subject/To lines to the body — strip it so content_text is the newsletter itself,
    not email plumbing. Not anchored to the start of the string so a personal note the forwarder
    typed above the boilerplate is preserved."""
    if not text:
        return text
    marker = _FORWARD_MARKER_RE.search(text)
    if not marker:
        return text.strip()
    before, after = text[:marker.start()], text[marker.end():]
    for anchor in _FORWARD_END_ANCHORS:
        end_re = re.compile(r'(?:.*\n){0,10}?\s*' + anchor + r':.*(?:\n|$)', re.IGNORECASE)
        m = end_re.match(after)
        if m:
            return (before + after[m.end():]).strip()
    return (before + after).strip()

async def process_newsletter_email(payload: dict) -> dict:
    """Entry point for the CloudMailin inbound-email webhook. A sibling to process_save, not a
    branch inside it — the input is a parsed email, not a URL to fetch. Resolves the sender to
    a ReCall user, extracts clean text from the HTML body, then converges on the exact same
    metadata/embedding/upsert tail every other source uses.
    Returns one of:
      {"no_match": True}
      {"thin_content": True}
      {"success": True, "title", "tag", "id"}
      {"error": True, "detail"}
    """
    headers = payload.get("headers") or {}
    sender_email = _resolve_forwarding_sender(headers)
    user_id = await _find_user_id_by_email(sender_email)
    if not user_id:
        print(f"[newsletter] no ReCall user matched sender={sender_email!r}", flush=True)
        return {"no_match": True}

    subject = headers.get("subject") or payload.get("subject") or "Untitled newsletter"
    html = payload.get("html") or (payload.get("body") or {}).get("html") or ""
    plain = payload.get("plain") or (payload.get("body") or {}).get("plain") or ""

    # The save's url always points back to the original email in the inbox via Gmail's
    # rfc822msgid: search deep link, not a link scraped out of the newsletter body — those
    # are unreliable (could be a confusing intermediate page, or ambiguous when an email has
    # several links) and the inbox copy is the one source that's always the real thing.
    # Gmail-specific (consistent with this feature's Gmail-first scope — see Known Issue #32).
    message_id = headers.get("message_id") or headers.get("message-id") or ""
    if message_id:
        url = f"https://mail.google.com/mail/u/0/#search/rfc822msgid:{quote(message_id.strip('<>'))}"
    else:
        url = f"newsletter://{time.time()}"

    clean_text = _strip_forwarded_header(_html_to_text(html) if html else plain.strip())
    from_header = headers.get("from") or ""
    sender_name_match = re.match(r'^"?([^"<]+)"?\s*<', from_header)
    if sender_name_match:
        sender_name = sender_name_match.group(1).strip()
    else:
        from_addr_match = re.search(r'[\w.+-]+@([\w-]+\.[\w.-]+)', from_header)
        sender_name = from_addr_match.group(1) if from_addr_match else ""
    extra_context = f"Newsletter from: {sender_name}" if sender_name else ""

    if len(clean_text.strip()) < NEWSLETTER_QUALITY_THRESHOLD:
        return {"thin_content": True}

    existing = await _exec(supabase.table("saves")
        .select("id, title, tag, created_at")
        .eq("user_id", user_id).eq("url", url)
        .limit(1))
    if existing.data:
        row = existing.data[0]
        return {"duplicate": True, "id": row["id"], "title": row["title"],
                "tag": row["tag"], "created_at": row["created_at"]}

    title, tag = await extract_save_metadata_async(subject, clean_text, extra_context)
    topics = await extract_topics_async(title, clean_text, extra_context)
    embedding = await get_embedding(f"{title} {clean_text}")
    topic_embedding = await get_embedding(topics, task_type="RETRIEVAL_DOCUMENT") if topics else None

    payload_row = {
        "user_id": user_id, "url": url, "title": title,
        "content_text": clean_text, "embedding": embedding, "tag": tag,
        "topics": topics, "topic_embedding": topic_embedding,
        "content_type": "article", "status": "ready"
    }
    try:
        result = await _exec(supabase.table("saves").insert(payload_row))
        inserted_id = result.data[0]["id"]
    except APIError as e:
        # Same race as process_save's insert sites — a concurrent save of this URL landed
        # after the duplicate check above but before this insert.
        if e.code != "23505":
            print(f"[newsletter] DB insert failed: {e}", flush=True)
            return {"error": True, "detail": "DB insert failed"}
        return await _duplicate_response(user_id, url)
    except Exception as e:
        print(f"[newsletter] DB insert failed: {e}", flush=True)
        return {"error": True, "detail": "DB insert failed"}

    await send_save_ready_push(user_id, title, "Newsletter")
    return {"success": True, "title": title, "tag": tag, "id": inserted_id}

SEARCH_MIN_SEMANTIC_SIMILARITY = 0.60  # cosine similarity floor for /search's semantic branch — re-derived empirically after the RETRIEVAL_QUERY/RETRIEVAL_DOCUMENT task_type fix, see CLAUDE.md Known Issue #34
SEARCH_SEMANTIC_WEIGHT = 1.0           # weight on match_saves' real cosine similarity in the fusion score
SEARCH_FTS_WEIGHT = 0.4                # weight on FTS rank-decay in the fusion score
SEARCH_TOPIC_WEIGHT = 1.5              # weight on topic_similarity (query vs precomputed topic phrase) — cleaner signal than raw content similarity, weighted higher; empirically tuned like its siblings, see CLAUDE.md Known Issue #36
SEARCH_TOPIC_MIN_SIMILARITY = 0.58     # floor on topic_similarity — additive weighting alone re-ranks but never removes candidates, so a long generic-adjacent tail still came back in full (verified directly: "crypto" returned 16 results, most of them noise). A real cutoff was needed, same lesson as SEARCH_MIN_SEMANTIC_SIMILARITY (Known Issue #34). 0.0 means "no topic_embedding yet" (missing data) and is never gated — only a genuinely low nonzero score is. Empirically tuned, see Known Issue #36.

async def do_search(query: str, user_id: str) -> dict:
    """Semantic + full-text search over a user's saves, combined via a magnitude-aware
    fusion score (see CLAUDE.md "4. Search" and Known Issue #33). Shared by /search
    and the recall_search MCP tool.

    Round 4 (Known Issue #36): no generative LLM call anywhere in this function — query
    expansion and the query-time relevance filter (round 3, Known Issue #35) were both
    replaced by a single query embedding compared against two precomputed vectors (content
    + topic), keeping the whole request to one embedding API call + fast Postgres queries.
    """
    query_embedding = await get_embedding(query, task_type="RETRIEVAL_QUERY")
    semantic_result = await _exec(supabase.rpc("match_saves", {
        "query_embedding": query_embedding,
        "match_user_id": user_id,
        "match_count": 20,
        "match_threshold": SEARCH_MIN_SEMANTIC_SIMILARITY,
        "topic_query_embedding": query_embedding
    }))

    # Full-text search over content + title — video/image saves now carry real content
    # (YouTube transcripts, Instagram captions, see CLAUDE.md's video-support round) so
    # they're no longer excluded here.
    try:
        fts_result = await _exec(supabase.table("saves")
            .select("id, url, title, tag, content_type, thumbnail_url, created_at, content_text")
            .eq("user_id", user_id)
            .eq("status", "ready")
            .filter("content_text", "fts", query)
            .order("created_at", desc=True)
            .limit(20))
        fts_rows = fts_result.data
    except Exception:
        fts_rows = []

    # Fusion: the semantic side contributes its real, already-thresholded cosine
    # similarity (match_saves excludes anything below SEARCH_MIN_SEMANTIC_SIMILARITY
    # before this code ever sees it) instead of a rank-slot fraction, plus topic_similarity
    # — the query embedding compared against a short, concentrated topic/entity phrase
    # precomputed at save time (Known Issue #36), weighted higher than raw content
    # similarity since it's the cleaner discriminator for broad queries in a topically
    # homogeneous library. The FTS side has no numeric relevance score available via
    # PostgREST's `.filter(col, "fts", query)` builder, so it keeps a rank-decay term,
    # confined to its own smaller weight so a merely-coincidental keyword hit can't
    # manufacture a semantic-grade score. Items in both lists get both terms summed,
    # preserving the "boost the intersection" property of the RRF design this replaced.
    # See CLAUDE.md "4. Search" and Known Issues #33/#36.
    scores = {}
    metadata = {}

    # Post-filter semantic results to exclude still-pending placeholders. Defense in depth
    # only — sql/015_video_search.sql now also enforces status = 'ready' directly in the
    # RPC's WHERE clause. Video/image saves are no longer excluded here (see CLAUDE.md's
    # video-support round) — content_type is now purely a display classifier, not a
    # searchability gate. Also enforces the topic_similarity floor
    # (SEARCH_TOPIC_MIN_SIMILARITY) here in Python rather than in match_saves' SQL — this
    # constant is still being empirically tuned (Known Issue #36) and a Python-side filter
    # is faster to retune than another migration.
    semantic_rows = [r for r in semantic_result.data
                      if r.get("status", "ready") == "ready"
                      and (r.get("topic_similarity", 0.0) == 0.0
                           or r.get("topic_similarity", 0.0) >= SEARCH_TOPIC_MIN_SIMILARITY)]

    for row in semantic_rows:
        rid = row["id"]
        scores[rid] = scores.get(rid, 0) + SEARCH_SEMANTIC_WEIGHT * row.get("similarity", 0.0) \
            + SEARCH_TOPIC_WEIGHT * row.get("topic_similarity", 0.0)
        metadata[rid] = row

    for rank, row in enumerate(fts_rows):
        rid = row["id"]
        scores[rid] = scores.get(rid, 0) + SEARCH_FTS_WEIGHT * (1 / (1 + rank))
        if rid not in metadata:
            metadata[rid] = row

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:20]
    results = []
    for rid, score in ranked:
        row = metadata[rid]
        # Fused relevance score, not a raw probability — never shown to the user (see
        # CLAUDE.md "4. Search", "no raw match %"); kept only for internal debugging/tuning.
        row["similarity"] = round(score, 4)
        # Build a short excerpt from content_text
        content = (row.get("content_text") or "").strip()
        if len(content) > 220:
            truncated = content[:220]
            last_space = truncated.rfind(" ")
            row["excerpt"] = (truncated[:last_space] + "…") if last_space > 0 else (truncated + "…")
        else:
            row["excerpt"] = content
        # Strip heavy fields before sending to client
        row.pop("content_text", None)
        row.pop("embedding", None)
        results.append(row)

    # Attach folder memberships — one batch query for all result IDs
    if results:
        save_ids = [r["id"] for r in results]
        folder_rows = await _exec(supabase.table("save_folders")
            .select("save_id, folders(id, name)")
            .in_("save_id", save_ids))
        folders_by_save: dict[str, list] = {}
        for fr in (folder_rows.data or []):
            folders_by_save.setdefault(fr["save_id"], []).append(fr["folders"])
        for r in results:
            r["folders"] = folders_by_save.get(r["id"], [])

    return {"results": results}

async def do_suggestions(user_id: str) -> dict:
    """Folder/source-based search-chip suggestions. Shared by /suggestions and the
    recall_suggestions MCP tool."""
    result = await _exec(supabase.table("saves")
        .select("url")
        .eq("user_id", user_id)
        .eq("status", "ready"))

    if not result.data:
        return {"chips": [], "has_saves": False}

    # Count source frequency across all saves
    source_counts: dict[str, int] = {}
    for row in result.data:
        src = get_source_label(row.get("url", ""))
        if src and src != "Page":
            source_counts[src] = source_counts.get(src, 0) + 1
    sorted_sources = sorted(source_counts.items(), key=lambda x: x[1], reverse=True)

    # Count folder usage for this user
    folder_result = await _exec(supabase.table("folders")
        .select("name, save_folders(save_id)")
        .eq("user_id", user_id))
    folder_counts = [(f["name"], len(f.get("save_folders") or [])) for f in (folder_result.data or [])]
    folder_counts.sort(key=lambda x: x[1], reverse=True)

    chips = []
    if folder_counts:
        chips.append(f"things in {folder_counts[0][0]}")
    if len(folder_counts) > 1 and len(chips) < 3:
        chips.append(f"my {folder_counts[1][0].lower()} saves")
    if sorted_sources and len(chips) < 3:
        chips.append(f"things from {sorted_sources[0][0]}")

    # Fallbacks if not enough variety
    fallbacks = ["what I've been reading", "recent saves", "links I collected"]
    while len(chips) < 3:
        chips.append(fallbacks[len(chips) % len(fallbacks)])

    return {"chips": chips[:3], "has_saves": True}

VALID_TAGS = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]

async def do_update_tag(save_id: str, tag: str, user_id: str) -> dict:
    """Shared by PATCH /save/{id}/tag and the recall_update_tag MCP tool."""
    if tag not in VALID_TAGS:
        raise ValueError("Invalid tag")
    await _exec(supabase.table("saves").update({"tag": tag})
        .eq("id", save_id).eq("user_id", user_id))
    return {"success": True}

async def do_update_title(save_id: str, title: str, user_id: str) -> dict:
    """Shared by PATCH /save/{id}/title and the recall_update_title MCP tool."""
    await _exec(supabase.table("saves").update({"title": title})
        .eq("id", save_id).eq("user_id", user_id))
    return {"success": True}

async def do_delete_save(save_id: str, user_id: str) -> dict:
    """Shared by DELETE /save/{id} and the recall_delete MCP tool."""
    await _exec(supabase.table("saves").delete()
        .eq("id", save_id).eq("user_id", user_id))
    # Best-effort: remove this save_id from related_ids arrays + wiki_pages source_ids
    try:
        await _exec(supabase.rpc("cleanup_deleted_save", {
            "deleted_save_id": save_id,
            "owner_user_id": user_id
        }))
    except Exception:
        pass
    return {"success": True}


# --- Folder management ---

async def do_get_folders(user_id: str) -> dict:
    result = await _exec(supabase.table("folders")
        .select("id, name, created_at, save_folders(save_id)")
        .eq("user_id", user_id)
        .order("created_at"))
    folders = []
    for f in (result.data or []):
        sf = f.get("save_folders") or []
        folders.append({
            "id": f["id"],
            "name": f["name"],
            "created_at": f["created_at"],
            "save_count": len(sf),
            "save_ids": [row["save_id"] for row in sf],
        })
    return {"folders": folders}


async def do_create_folder(name: str, user_id: str) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("Folder name cannot be empty")
    if len(name) > 50:
        raise ValueError("Folder name must be 50 characters or fewer")
    try:
        result = await _exec(supabase.table("folders").insert({
            "user_id": user_id,
            "name": name,
        }))
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise ValueError(f'A folder named "{name}" already exists')
        raise
    return {"success": True, "id": result.data[0]["id"], "name": name}


async def do_rename_folder(folder_id: str, name: str, user_id: str) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("Folder name cannot be empty")
    if len(name) > 50:
        raise ValueError("Folder name must be 50 characters or fewer")
    try:
        await _exec(supabase.table("folders").update({"name": name})
            .eq("id", folder_id).eq("user_id", user_id))
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise ValueError(f'A folder named "{name}" already exists')
        raise
    return {"success": True}


async def do_delete_folder(folder_id: str, user_id: str) -> dict:
    # CASCADE on save_folders FK means memberships are removed automatically
    await _exec(supabase.table("folders").delete()
        .eq("id", folder_id).eq("user_id", user_id))
    return {"success": True}


async def do_set_save_folders(save_id: str, folder_ids: list, user_id: str) -> dict:
    # Validate the save belongs to this user
    check = await _exec(supabase.table("saves").select("id")
        .eq("id", save_id).eq("user_id", user_id))
    if not check.data:
        raise ValueError("Save not found")
    # Validate all requested folders belong to this user
    if folder_ids:
        folder_check = await _exec(supabase.table("folders").select("id")
            .in_("id", folder_ids).eq("user_id", user_id))
        found_ids = {f["id"] for f in (folder_check.data or [])}
        if len(found_ids) != len(folder_ids):
            raise ValueError("One or more folders not found")
    # Atomically replace all memberships for this save
    await _exec(supabase.table("save_folders").delete().eq("save_id", save_id))
    if folder_ids:
        await _exec(supabase.table("save_folders").insert([
            {"save_id": save_id, "folder_id": fid} for fid in folder_ids
        ]))
    return {"success": True}
