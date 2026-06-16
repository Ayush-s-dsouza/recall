from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import os
import re
import io
import math
import socket
import ipaddress
import json
import zipfile
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import httpx
import asyncio
import sentry_sdk
from collections import defaultdict
from supabase import create_client
from google import genai
from google.genai import types

load_dotenv()

sentry_sdk.init(dsn=os.getenv("SENTRY_DSN", ""), traces_sample_rate=0.05)

import sys
sys.stdout.reconfigure(line_buffering=True)

app = FastAPI()

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))

# Module-level Gemini client — created once at startup, reused across all requests
gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
_executor = ThreadPoolExecutor(max_workers=4)

# Typed ThinkingConfig — disables thinking tokens for all generate_content calls.
# Falls back to empty config on old SDK versions that predate ThinkingConfig.
try:
    _NO_THINKING = types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_budget=0)
    )
except AttributeError:
    _NO_THINKING = types.GenerateContentConfig()

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
            if any(ip in net for net in _PRIVATE_RANGES):
                return False
        return True
    except Exception:
        return False

def validate_url(url: str):
    """Raise 400 if URL is not safe to fetch."""
    if not is_safe_url(url):
        raise HTTPException(status_code=400, detail="Invalid URL")


class SaveRequest(BaseModel):
    url: str
    token: str

class SearchRequest(BaseModel):
    query: str
    token: str

class UpdateTitleRequest(BaseModel):
    title: str
    token: str

class UpdateTagRequest(BaseModel):
    tag: str
    token: str

class DeleteRequest(BaseModel):
    token: str

class SuggestionsRequest(BaseModel):
    token: str

class DeleteAccountRequest(BaseModel):
    token: str

class AskRequest(BaseModel):
    query: str
    token: str

class LibraryRequest(BaseModel):
    token: str

class SaveWikiRequest(BaseModel):
    query: str
    synthesis: str
    source_ids: list[str]
    token: str

class WikiTokenRequest(BaseModel):
    token: str

class ImportStatusRequest(BaseModel):
    token: str

MEDIA_URLS = [
    ("youtube.com/watch",    "video", "YouTube videos"),
    ("youtube.com/shorts/",  "video", "YouTube Shorts"),
    ("youtu.be/",            "video", "YouTube videos"),
    ("tiktok.com/",          "video", "TikTok videos"),
    ("instagram.com/reel/",  "video", "Instagram Reels"),
    ("instagram.com/p/",     "image", "Instagram posts"),
]
QUALITY_THRESHOLD = 100  # chars — below this, content is too thin to be useful
ASK_MIN_RELEVANCE = 0.5  # cosine similarity floor for /ask context — filters weakly-related saves
MAX_IMPORT_ITEMS = 500  # cap per bulk import job to bound Gemini/Jina usage
IMPORT_DELAY_SECONDS = int(os.getenv("IMPORT_DELAY_SECONDS", "3"))
TWEET_URL_RE = re.compile(r'(?:twitter\.com|x\.com)/\w{1,15}/status/(\d{1,20})')

def get_user_id(token: str):
    user = supabase.auth.get_user(token)
    return user.user.id

def get_source_label(url: str) -> str:
    if not url:
        return "Page"
    if "twitter.com" in url or "x.com" in url:
        return "X (Twitter)"
    if "linkedin.com" in url:
        return "LinkedIn"
    if "reddit.com" in url:
        return "Reddit"
    if "youtube.com" in url or "youtu.be" in url:
        return "YouTube"
    if "substack.com" in url:
        return "Substack"
    try:
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        host = host.replace("www.", "")
        return host.capitalize() if host else "Page"
    except:
        return "Page"

async def get_embedding(text: str):
    api_key = os.getenv("GEMINI_API_KEY")
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key={api_key}",
            json={
                "model": "models/gemini-embedding-001",
                "content": {"parts": [{"text": text[:8000]}]},
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

def extract_og_tags(html: str) -> dict:
    """Extract Open Graph and meta description tags from raw HTML."""
    result = {}
    for meta in re.finditer(r'<meta\s+([^>]+?)/?>', html, re.IGNORECASE | re.DOTALL):
        attrs_str = meta.group(1)
        prop_match = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', attrs_str, re.IGNORECASE)
        content_match = re.search(r'content\s*=\s*["\']([^"\']*)["\']', attrs_str, re.IGNORECASE)
        if prop_match and content_match:
            result[prop_match.group(1).lower()] = content_match.group(1).strip()
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
            res = await client.get(image_url, follow_redirects=True)
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
            res = await client.get(embed_url, follow_redirects=True)
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

async def fetch_youtube(url: str):
    """Use YouTube's oEmbed API to get video title and channel name without auth."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                "https://www.youtube.com/oembed",
                params={"url": url, "format": "json"},
                follow_redirects=True
            )
            data = res.json()
            title = data.get("title", "")
            author = data.get("author_name", "")
            return title, author
    except:
        return "", ""

async def _fetch_tweet_oembed(url: str) -> tuple[str, str, str]:
    """oEmbed gives reliable author name + basic tweet text + first linked URL."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                "https://publish.twitter.com/oembed",
                params={"url": url, "omit_script": "true"},
                follow_redirects=True
            )
        data = res.json()
        author = data.get("author_name", "")
        raw_html = data.get("html", "")
        tco_urls = re.findall(r'href="(https://t\.co/[^"]+)"', raw_html)
        text = re.sub(r'<[^>]+>', ' ', raw_html)
        text = re.sub(r'\s+', ' ', text).strip()
        return text, author, tco_urls[0] if tco_urls else ""
    except Exception:
        return "", "", ""

async def _fetch_tweet_card_title(tweet_url: str) -> str:
    """Twitter syndication API — returns tweet card title (article title for X Articles) without auth."""
    m = re.search(r'/status/(\d+)', tweet_url)
    if not m:
        return ""
    tweet_id = m.group(1)
    try:
        val = math.floor(int(tweet_id) / 1e15 * math.pi)
        chars = "0123456789abcdefghijklmnopqrstuvwxyz"
        token = ""
        while val > 0:
            token = chars[int(val) % 36] + token
            val //= 36
        token = token or "0"
        async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
            res = await client.get(
                "https://cdn.syndication.twimg.com/tweet-result",
                params={"id": tweet_id, "token": token, "lang": "en"},
                follow_redirects=True
            )
            print(f"[syndication] status={res.status_code} token={token} tweet_id={tweet_id} body={res.text[:500]}", flush=True)
            data = res.json()
            bv = (data.get("card") or {}).get("binding_values") or {}
            return bv.get("title", {}).get("string_value", "")
    except Exception as e:
        print(f"[syndication] exception: {e}", flush=True)
        return ""

async def fetch_tweet(url: str):
    """Jina Reader for richer content (quoted tweets, linked previews); oEmbed as author source + text fallback."""
    (jina_text, jina_title), (oembed_text, author, tco_url), og_html, card_title = await asyncio.gather(
        fetch_with_jina(url),
        _fetch_tweet_oembed(url),
        fetch_og_html(url),
        _fetch_tweet_card_title(url)
    )
    og_title = extract_og_tags(og_html).get("og:title", "")
    # Filter generic X platform titles like "Rork (@rork) on X"
    if " on X" in og_title or og_title.endswith("on Twitter"):
        og_title = ""
    content = jina_text if len(jina_text) > len(oembed_text) else oembed_text
    return content, author, card_title or jina_title or og_title, tco_url

async def fetch_with_jina(url: str) -> tuple[str, str]:
    """Fetch clean article content via Jina Reader (handles JS rendering, 'read more', etc).
    Returns (clean_text, title). Falls back to ("", "") on failure."""
    try:
        async with httpx.AsyncClient(timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)",
            "X-Return-Format": "text",
        }) as client:
            res = await client.get(f"https://r.jina.ai/{url}", follow_redirects=True)
            if res.status_code != 200 or len(res.text) < 150:
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
    except Exception:
        return "", ""

async def fetch_og_html(url: str) -> str:
    """Quick fetch of raw page HTML for OG tag + title extraction."""
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
            r = await client.get(url, follow_redirects=True)
            return r.text[:10000]
    except Exception:
        return ""

async def process_save(url: str, user_id: str) -> dict:
    """Core save pipeline shared by /save and the bookmark import job.
    Returns one of:
      {"duplicate": True, "id", "title", "tag", "created_at"}
      {"thin_content": True, "url"}
      {"success": True, "media": True, "content_type", "label", "title", "tag", "id"}
      {"success": True, "title", "tag", "id", "related_ids"}
      {"error": True, "url", "detail"}
    Never raises — import loop can safely tally result dicts without try/except per call.
    """
    existing = supabase.table("saves") \
        .select("id, title, tag, created_at") \
        .eq("user_id", user_id).eq("url", url) \
        .limit(1).execute()
    if existing.data:
        row = existing.data[0]
        return {"duplicate": True, "id": row["id"], "title": row["title"],
                "tag": row["tag"], "created_at": row["created_at"]}

    # --- Media URL detection: lightweight save, skip full Gemini pipeline ---
    for pattern, ctype, label in MEDIA_URLS:
        if pattern in url:
            if "youtube.com" in url or "youtu.be" in url:
                yt_title, yt_author = await fetch_youtube(url)
                if yt_title:
                    raw_title = f"{yt_title} · {yt_author}" if yt_author else yt_title
                else:
                    raw_title = url
            else:
                try:
                    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                        r = await client.get(url, follow_redirects=True)
                        og = extract_og_tags(r.text[:5000])
                        raw_title = og.get("og:title") or url
                except:
                    raw_title = url
            embedding = await get_embedding(raw_title)
            _, tag = await extract_save_metadata_async(raw_title, "", "")
            try:
                result = supabase.table("saves").insert({
                    "user_id": user_id,
                    "url": url,
                    "title": raw_title,
                    "content_text": "",
                    "embedding": embedding,
                    "tag": tag,
                    "content_type": ctype
                }).execute()
                inserted_id = result.data[0]["id"]
            except Exception as e:
                print(f"[media save] DB insert failed: {e}", flush=True)
                return {"error": True, "url": url, "detail": "DB insert failed"}
            return {"success": True, "media": True, "content_type": ctype,
                    "label": label, "title": raw_title, "tag": tag, "id": inserted_id}

    is_tweet = "x.com" in url or "twitter.com" in url
    is_instagram = "instagram.com" in url
    is_linkedin = "linkedin.com" in url

    extra_context = ""

    if is_tweet:
        clean_text, tweet_author, jina_title, tco_url = await fetch_tweet(url)
        print(f"[tweet] author={repr(tweet_author)} jina_title={repr(jina_title)} tco_url={repr(tco_url)} clean_text_len={len(clean_text)} clean_text_preview={repr(clean_text[:150])}", flush=True)
        article_title = ""
        if tco_url and is_safe_url(tco_url):
            try:
                async with httpx.AsyncClient(timeout=8, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                    r = await client.get(tco_url)
                    final_url = str(r.url)
                if "x.com/i/article/" in final_url or "twitter.com/i/article/" in final_url:
                    # X Article — try OG tags and Jina in parallel
                    (article_jina_text, article_jina_title), article_og_html = await asyncio.gather(
                        fetch_with_jina(final_url),
                        fetch_og_html(final_url)
                    )
                    article_og_title = extract_og_tags(article_og_html).get("og:title", "")
                    if article_jina_text:
                        clean_text = article_jina_text
                    article_title = article_og_title or article_jina_title
                    print(f"[tweet] X Article — og_title={repr(article_og_title)} jina_title={repr(article_jina_title)} content_len={len(clean_text)}", flush=True)
                elif "twitter.com" not in final_url and "x.com" not in final_url:
                    og = extract_og_tags(r.text[:5000])
                    article_title = og.get("og:title", "")
                    print(f"[tweet] external link — final_url={repr(final_url)} article_title={repr(article_title)}", flush=True)
            except Exception as e:
                print(f"[tweet] tco resolution failed: {e}", flush=True)
        stub_only = not clean_text or clean_text.strip().startswith("https://t.co/") or len(clean_text) < 80
        title = article_title or jina_title or (clean_text[:100].strip() if not stub_only else "") or tweet_author or url
        print(f"[tweet] final title passed to extract_save_metadata: {repr(title)}", flush=True)
    elif is_instagram:
        caption, author, thumbnail_url = await fetch_instagram(url)
        clean_text = caption
        title = author or "Instagram"
        # If caption is sparse, analyze the thumbnail image
        if thumbnail_url and len(clean_text) < 400:
            image_description = await analyze_image(thumbnail_url)
            if image_description:
                extra_context = f"Image: {image_description}"
                clean_text = (clean_text + "\n\n" + extra_context).strip()
    elif is_linkedin:
        (jina_text, jina_title), raw_html = await asyncio.gather(
            fetch_with_jina(url),
            fetch_og_html(url)
        )
        og = extract_og_tags(raw_html)
        og_title = og.get("og:title", "")
        og_description = og.get("og:description", "") or og.get("description", "")

        # OG description is the post body (reliable); Jina adds depth for "See more" expansion
        combined = og_description if og_description else ""
        if jina_text and len(jina_text) > len(og_description):
            combined = jina_text

        # Strip LinkedIn UI boilerplate that Jina extracts
        for noise in ["Like · Comment · Share", "Like Comment Share", "1st · ", "2nd · ",
                      "3rd · ", "Connect", "Follow", "Message", "View all comments",
                      "Load more comments", "Sign in to view", "Join now to see"]:
            combined = combined.replace(noise, "")
        clean_text = re.sub(r'\s{2,}', ' ', combined).strip()

        title = og_title or jina_title or url
        if len(clean_text.strip()) < QUALITY_THRESHOLD:
            return {"thin_content": True, "url": url}
    else:
        # Run Jina Reader and raw OG fetch concurrently for speed
        (jina_text, jina_title), raw_html = await asyncio.gather(
            fetch_with_jina(url),
            fetch_og_html(url)
        )

        title_match = re.search(r'<title>(.*?)</title>', raw_html, re.IGNORECASE)
        html_title = title_match.group(1) if title_match else ""
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
            return {"thin_content": True, "url": url}

    title, tag = await extract_save_metadata_async(title, clean_text, extra_context)
    embedding = await get_embedding(f"{title} {clean_text}")

    try:
        result = supabase.table("saves").insert({
            "user_id": user_id,
            "url": url,
            "title": title,
            "content_text": clean_text,
            "embedding": embedding,
            "tag": tag,
            "content_type": "article"
        }).execute()
        inserted_id = result.data[0]["id"]
    except Exception as e:
        print(f"[save] DB insert failed: {e}", flush=True)
        return {"error": True, "url": url, "detail": "DB insert failed"}

    # Find semantically related saves and store cross-references (best-effort)
    related_ids = []
    try:
        related_result = supabase.rpc("find_related_saves", {
            "save_embedding": embedding,
            "exclude_id": inserted_id,
            "match_user_id": user_id,
            "match_count": 3
        }).execute()
        related_ids = [r["id"] for r in (related_result.data or [])]
        if related_ids:
            supabase.table("saves").update({"related_ids": related_ids}) \
                .eq("id", inserted_id).execute()
    except Exception:
        pass  # Silently skip if RPC/column not yet set up in Supabase

    return {"success": True, "title": title, "tag": tag, "id": inserted_id, "related_ids": related_ids}


@app.post("/save")
@limiter.limit("10/minute")
async def save_url(req: SaveRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    validate_url(req.url)

    result = await process_save(req.url, user_id)
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["detail"])
    return result

async def expand_search_query(query: str) -> str:
    """Expand a short query with related synonyms/concepts to improve semantic recall."""
    if len(query.split()) >= 6:
        return query  # already specific enough — skip Gemini call
    try:
        loop = asyncio.get_running_loop()
        response = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                lambda: gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=(
                        "Rewrite this search query as a short phrase with 3-5 related synonyms "
                        "and concepts to improve semantic search. Return only the expanded query, no explanation.\n"
                        f"Query: {query}"
                    ),
                    config=_NO_THINKING
                )
            ),
            timeout=8.0
        )
        return response.text.strip()
    except Exception:
        return query

@app.post("/search")
@limiter.limit("30/minute")
async def search(req: SearchRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Expand short queries before embedding to improve semantic recall; FTS uses original
    q_expanded = await expand_search_query(req.query)
    query_embedding = await get_embedding(q_expanded)
    semantic_result = supabase.rpc("match_saves", {
        "query_embedding": query_embedding,
        "match_user_id": user_id,
        "match_count": 20
    }).execute()

    # Full-text search over content + title — exclude media saves
    try:
        fts_result = supabase.table("saves") \
            .select("id, url, title, tag, created_at, content_text") \
            .eq("user_id", user_id) \
            .eq("content_type", "article") \
            .filter("content_text", "fts", req.query) \
            .limit(20) \
            .execute()
        fts_rows = fts_result.data
    except Exception:
        fts_rows = []

    # Reciprocal Rank Fusion (k=60 is standard)
    K = 60
    scores = {}
    metadata = {}

    # Post-filter semantic results to exclude media saves
    semantic_rows = [r for r in semantic_result.data if r.get("content_type", "article") == "article"]

    for rank, row in enumerate(semantic_rows):
        rid = row["id"]
        scores[rid] = scores.get(rid, 0) + 1 / (K + rank + 1)
        metadata[rid] = row

    for rank, row in enumerate(fts_rows):
        rid = row["id"]
        scores[rid] = scores.get(rid, 0) + 1 / (K + rank + 1)
        if rid not in metadata:
            metadata[rid] = row

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:20]
    max_score = ranked[0][1] if ranked else 1
    results = []
    for rid, score in ranked:
        row = metadata[rid]
        row["similarity"] = score / max_score
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

    return {"results": results}

@app.patch("/save/{save_id}/tag")
async def update_tag(save_id: str, req: UpdateTagRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    valid_tags = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]
    if req.tag not in valid_tags:
        raise HTTPException(status_code=400, detail="Invalid tag")
    supabase.table("saves").update({"tag": req.tag}) \
        .eq("id", save_id).eq("user_id", user_id).execute()
    return {"success": True}

@app.delete("/save/{save_id}")
async def delete_save(save_id: str, req: DeleteRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("saves").delete() \
        .eq("id", save_id).eq("user_id", user_id).execute()
    # Best-effort: remove this save_id from related_ids arrays + wiki_pages source_ids
    try:
        supabase.rpc("cleanup_deleted_save", {
            "deleted_save_id": save_id,
            "owner_user_id": user_id
        }).execute()
    except Exception:
        pass
    return {"success": True}

@app.patch("/save/{save_id}/title")
async def update_title(save_id: str, req: UpdateTitleRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("saves").update({"title": req.title}) \
        .eq("id", save_id).eq("user_id", user_id).execute()
    return {"success": True}

@app.post("/suggestions")
async def get_suggestions(req: SuggestionsRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Unauthorized")

    result = supabase.table("saves") \
        .select("tag, url") \
        .eq("user_id", user_id) \
        .execute()

    if not result.data:
        return {"chips": [], "has_saves": False}

    # Count tags and sources across all saves
    tag_counts = {}
    source_counts = {}
    for row in result.data:
        t = row.get("tag") or "Other"
        tag_counts[t] = tag_counts.get(t, 0) + 1
        src = get_source_label(row.get("url", ""))
        if src and src != "Page":
            source_counts[src] = source_counts.get(src, 0) + 1

    sorted_tags = sorted(tag_counts.items(), key=lambda x: x[1], reverse=True)
    sorted_sources = sorted(source_counts.items(), key=lambda x: x[1], reverse=True)

    chips = []
    if sorted_tags:
        chips.append(f"my {sorted_tags[0][0].lower()} reads")
    if len(sorted_tags) > 1:
        chips.append(f"{sorted_tags[1][0].lower()} articles")
    if sorted_sources and len(chips) < 3:
        chips.append(f"things from {sorted_sources[0][0]}")

    # Fallbacks if not enough variety
    fallbacks = ["what I've been reading", "recent saves", "links I collected"]
    while len(chips) < 3:
        chips.append(fallbacks[len(chips) % len(fallbacks)])

    return {"chips": chips[:3], "has_saves": True}

@app.delete("/account")
async def delete_account(req: DeleteAccountRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("saves").delete().eq("user_id", user_id).execute()
    supabase.auth.admin.delete_user(user_id)
    return {"success": True}

@app.post("/ask")
@limiter.limit("20/minute")
async def ask_recall(req: AskRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    query_embedding = await get_embedding(req.query)
    semantic_result = supabase.rpc("match_saves", {
        "query_embedding": query_embedding,
        "match_user_id": user_id,
        "match_count": 8
    }).execute()

    # Filter to articles with sufficient semantic relevance.
    # similarity comes from match_saves RPC if it returns that column (requires SQL update).
    # Default 1.0 means "assume relevant" when column absent — preserves behaviour before SQL migration.
    article_saves = [
        r for r in (semantic_result.data or [])
        if r.get("content_type", "article") == "article"
        and r.get("content_text")
        and r.get("similarity", 1.0) >= ASK_MIN_RELEVANCE
    ]

    relevant_count = len(article_saves)
    if relevant_count < 3:
        return {"synthesis": None, "sources": [], "insufficient": True, "relevant_count": relevant_count}

    context_parts = []
    for row in article_saves[:8]:
        title = row.get("title", "Unknown")
        content = (row.get("content_text") or "")[:600].strip()
        context_parts.append(f"[{title}]\n{content}")
    context = "\n\n---\n\n".join(context_parts)

    prompt = f"""You are a personal knowledge assistant synthesizing information from articles the user has saved to their library. Answer their question in 2-3 concise paragraphs using ONLY what is in the provided articles. Cite sources inline using the article title in square brackets like [Article Title]. If the articles don't contain enough information to answer well, say so briefly.

Articles from the user's library:
{context}

Question: {req.query}"""

    try:
        loop = asyncio.get_running_loop()
        response = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                lambda: gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt,
                    config=_NO_THINKING
                )
            ),
            timeout=25.0
        )
        synthesis = response.text.strip()
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Synthesis timed out — try a more focused question")
    except Exception:
        raise HTTPException(status_code=500, detail="Synthesis failed")

    sources = [
        {
            "id": r["id"],
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "tag": r.get("tag", ""),
            # exact slice fed to the LLM — used by groundcheck for faithfulness evaluation
            "content_snippet": (r.get("content_text") or "")[:600].strip(),
        }
        for r in article_saves[:8]
    ]

    return {"synthesis": synthesis, "sources": sources, "insufficient": False}


@app.post("/library")
@limiter.limit("10/hour")
async def get_library(req: LibraryRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = supabase.table("saves") \
        .select("id, title, tag, content_text, created_at") \
        .eq("user_id", user_id) \
        .eq("content_type", "article") \
        .order("created_at", desc=True) \
        .execute()

    if not result.data:
        return {"library": []}

    tag_groups = defaultdict(list)
    for row in result.data:
        tag_groups[row.get("tag") or "Other"].append(row)

    library = []

    for tag, saves in sorted(tag_groups.items(), key=lambda x: -len(x[1])):
        count = len(saves)
        recent_titles = [s["title"] for s in saves[:3]]
        word_count = sum(len((s.get("content_text") or "").split()) for s in saves)
        summary = ""
        sub_topics = []

        if count >= 3:
            titles_sample = "\n".join(f"- {s['title']}" for s in saves[:10])
            try:
                prompt = f"""In 1-2 sentences, summarize the key themes across these {count} saved articles under the "{tag}" category. Be specific about recurring topics, not generic.

Titles:
{titles_sample}

Write only the summary, nothing else."""
                response = gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt,
                    config=_NO_THINKING
                )
                summary = response.text.strip()
            except Exception:
                summary = ""

        if count >= 5:
            indexed_titles = "\n".join(f"{i}: {s['title']}" for i, s in enumerate(saves[:20]))
            try:
                sub_prompt = f"""These {min(count, 20)} articles are saved under "{tag}".
Identify 2-4 specific micro-topic clusters (2-5 words each, concrete not generic).
Assign each article index to exactly one cluster.

Articles:
{indexed_titles}

Return JSON only, no markdown fences:
{{"sub_topics": [{{"label": "AI & Language Models", "indices": [0, 3, 7]}}, ...]}}"""
                sub_response = gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=sub_prompt,
                    config=_NO_THINKING
                )
                raw = sub_response.text.strip().strip("```json").strip("```").strip()
                parsed = json.loads(raw)
                sub_topics = [
                    {"label": st["label"], "count": len(st.get("indices", []))}
                    for st in parsed.get("sub_topics", [])
                    if st.get("label") and st.get("indices")
                ]
            except Exception:
                sub_topics = []

        library.append({
            "tag": tag,
            "count": count,
            "summary": summary,
            "recent_titles": recent_titles,
            "word_count": word_count,
            "sub_topics": sub_topics,
        })

    return {"library": library}


@app.post("/wiki")
async def save_wiki_insight(req: SaveWikiRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = supabase.table("wiki_pages").insert({
        "user_id": user_id,
        "query": req.query,
        "synthesis": req.synthesis,
        "source_ids": req.source_ids
    }).execute()
    return {"success": True, "id": result.data[0]["id"]}


@app.post("/wiki/list")
async def list_wiki_insights(req: WikiTokenRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = supabase.table("wiki_pages") \
        .select("id, query, synthesis, source_ids, created_at") \
        .eq("user_id", user_id) \
        .order("created_at", desc=True) \
        .execute()
    return {"insights": result.data or []}


@app.delete("/wiki/{wiki_id}")
async def delete_wiki_insight(wiki_id: str, req: WikiTokenRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("wiki_pages").delete() \
        .eq("id", wiki_id).eq("user_id", user_id).execute()
    return {"success": True}


# ---------------------------------------------------------------------------
# Bookmark import — helpers and endpoints
# ---------------------------------------------------------------------------

def extract_tweet_ids(raw: bytes, filename: str) -> list[str]:
    """Extract tweet IDs from any bookmark export (JSON, CSV, .js, or zip archive)
    by scanning for x.com/twitter.com status URLs. Format-agnostic — works with
    any export tool's output as long as the file contains links back to the posts."""
    texts = []
    if raw[:2] == b"PK":  # zip magic bytes
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                for name in zf.namelist():
                    if name.lower().endswith((".js", ".json", ".csv", ".txt")):
                        texts.append(zf.read(name).decode("utf-8", errors="ignore"))
        except zipfile.BadZipFile:
            texts.append(raw.decode("utf-8", errors="ignore"))
    else:
        texts.append(raw.decode("utf-8", errors="ignore"))

    seen, ids = set(), []
    for text in texts:
        for m in TWEET_URL_RE.finditer(text):
            tid = m.group(1)
            if tid not in seen:
                seen.add(tid)
                ids.append(tid)
    return ids


def tweet_id_to_url(tweet_id: str) -> str:
    return f"https://x.com/i/web/status/{tweet_id}"


async def run_import_job(job_id: str, user_id: str, tweet_ids: list[str]):
    succeeded = duplicates = failed = skipped = 0
    for i, tid in enumerate(tweet_ids):
        url = tweet_id_to_url(tid)
        try:
            validate_url(url)
            result = await process_save(url, user_id)
            if result.get("duplicate"):
                duplicates += 1
            elif result.get("thin_content"):
                skipped += 1
            elif result.get("success"):
                succeeded += 1
            else:
                failed += 1
        except Exception as e:
            print(f"[import {job_id}] item {tid} failed: {e}", flush=True)
            failed += 1

        try:
            supabase.table("import_jobs").update({
                "processed": i + 1, "succeeded": succeeded, "duplicates": duplicates,
                "failed": failed, "skipped": skipped,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", job_id).execute()
        except Exception as e:
            print(f"[import {job_id}] status update failed: {e}", flush=True)

        if i < len(tweet_ids) - 1:
            await asyncio.sleep(IMPORT_DELAY_SECONDS)

    try:
        supabase.table("import_jobs").update({
            "status": "completed",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", job_id).execute()
    except Exception as e:
        print(f"[import {job_id}] final status update failed: {e}", flush=True)


@app.post("/import/x-bookmarks")
@limiter.limit("2/hour")
async def import_x_bookmarks(request: Request, token: str = Form(...), file: UploadFile = File(...)):
    try:
        user_id = get_user_id(token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    raw = await file.read()
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 50 MB)")

    all_ids = extract_tweet_ids(raw, file.filename or "")
    if not all_ids:
        raise HTTPException(
            status_code=400,
            detail="No X/Twitter bookmark links found in this file. Make sure you exported with a tool that includes links to the posts."
        )

    existing_job = supabase.table("import_jobs") \
        .select("id").eq("user_id", user_id).eq("status", "running").limit(1).execute()
    if existing_job.data:
        raise HTTPException(status_code=409, detail="An import is already in progress")

    tweet_ids = all_ids[:MAX_IMPORT_ITEMS]
    job = supabase.table("import_jobs").insert({
        "user_id": user_id, "source": "x_bookmarks", "status": "running",
        "total": len(tweet_ids), "processed": 0, "succeeded": 0,
        "duplicates": 0, "skipped": 0, "failed": 0,
    }).execute()
    job_id = job.data[0]["id"]

    asyncio.create_task(run_import_job(job_id, user_id, tweet_ids))

    return {
        "job_id": job_id,
        "total": len(tweet_ids),
        "total_found": len(all_ids),
        "capped": len(all_ids) > len(tweet_ids),
    }


@app.post("/import/status/{job_id}")
async def import_status(job_id: str, req: ImportStatusRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = supabase.table("import_jobs").select("*") \
        .eq("id", job_id).eq("user_id", user_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = result.data[0]
    # Surface stalled jobs — asyncio task dies if Railway restarts mid-import
    if job["status"] == "running":
        updated = datetime.fromisoformat(job["updated_at"])
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - updated > timedelta(minutes=2):
            job["status"] = "stalled"
    return job


@app.post("/import/jobs/latest")
async def latest_import_job(req: ImportStatusRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = supabase.table("import_jobs").select("*") \
        .eq("user_id", user_id).order("created_at", desc=True).limit(1).execute()
    return {"job": result.data[0] if result.data else None}


@app.get("/")
async def root():
    return {"status": "ReCall backend running"}