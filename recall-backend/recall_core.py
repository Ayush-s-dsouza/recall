"""Shared business logic for ReCall, used by both the REST API (main.py) and the
remote MCP server (mcp_server.py). Kept in its own module so main.py can mount
mcp_server.py's ASGI app without a circular import.
"""
import os
import re
import math
import socket
import ipaddress
import asyncio
import html as html_entities
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import HTTPException
from dotenv import load_dotenv
from supabase import create_client
from google import genai
from google.genai import types

load_dotenv()

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

MEDIA_URLS = [
    ("youtube.com/watch",    "video", "YouTube videos"),
    ("youtube.com/shorts/",  "video", "YouTube Shorts"),
    ("youtu.be/",            "video", "YouTube videos"),
    ("tiktok.com/",          "video", "TikTok videos"),
    ("instagram.com/reel/",  "video", "Instagram Reels"),
    ("instagram.com/p/",     "image", "Instagram posts"),
]
QUALITY_THRESHOLD = 100  # chars — below this, content is too thin to be useful
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
        if res.status_code != 200:
            print(f"[oembed] non-200: {res.status_code} body={res.text[:200]!r} url={url}", flush=True)
            return "", "", ""
        data = res.json()
        author = data.get("author_name", "")
        raw_html = data.get("html", "")
        tco_urls = re.findall(r'href="(https://t\.co/[^"]+)"', raw_html)
        text = re.sub(r'<[^>]+>', ' ', raw_html)
        text = re.sub(r'\s+', ' ', text).strip()
        return text, author, tco_urls[0] if tco_urls else ""
    except Exception as e:
        print(f"[oembed] exception: {e!r} url={url}", flush=True)
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
            data = res.json()
            article = data.get("article") or {}
            if article.get("title"):
                return article["title"], article.get("preview_text", "")
            bv = (data.get("card") or {}).get("binding_values") or {}
            return bv.get("title", {}).get("string_value", ""), ""
    except Exception as e:
        print(f"[syndication] exception: {e}", flush=True)
        return "", ""

async def fetch_tweet(url: str):
    """Jina Reader for richer content (quoted tweets, linked previews); oEmbed as author source + text fallback."""
    (jina_text, jina_title), (oembed_text, author, tco_url), og_html, (card_title, card_preview) = await asyncio.gather(
        fetch_with_jina(url),
        _fetch_tweet_oembed(url),
        fetch_og_html(url),
        _fetch_tweet_card_title(url)
    )
    og_title = extract_og_tags(og_html).get("og:title", "")
    if " on X" in og_title or og_title.endswith("on Twitter"):
        og_title = ""
    content = jina_text if len(jina_text) > len(oembed_text) else oembed_text
    if card_preview and len(card_preview) > len(content):
        content = card_preview
    return content, author, card_title or jina_title or og_title, tco_url

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
            res = await client.get(f"https://r.jina.ai/{url}", follow_redirects=True)
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
            r = await client.get(url, follow_redirects=True)
            return r.text[:10000]
    except Exception:
        return ""

async def process_save(url: str, user_id: str) -> dict:
    """Core save pipeline shared by /save, the bookmark import job, and the recall_save MCP tool.
    Returns one of:
      {"duplicate": True, "id", "title", "tag", "created_at"}
      {"thin_content": True, "url"}
      {"success": True, "media": True, "content_type", "label", "title", "tag", "id"}
      {"success": True, "title", "tag", "id", "related_ids"}
      {"error": True, "url", "detail"}
    Never raises for save-pipeline-internal failures — but get_embedding can still raise
    HTTPException (503) on a Gemini outage; callers should be prepared to catch that too.
    """
    # Resolve LinkedIn safety redirects to the actual destination URL
    if "linkedin.com/safety/go" in url:
        try:
            params = parse_qs(urlparse(url).query)
            target = params.get("url", [""])[0]
            if target:
                async with httpx.AsyncClient(timeout=8, follow_redirects=True,
                        headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                    r = await client.get(target)
                    resolved = str(r.url)
                validate_url(resolved)
                url = resolved
        except Exception:
            pass

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
        if title == url:
            # Nothing usable came back at all (deleted/protected/unfetchable tweet) — skip
            # rather than insert a row whose only "title" is the URL itself.
            return {"thin_content": True, "url": url}
        if tweet_author:
            extra_context = f"Author: {tweet_author}"
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

        # LinkedIn's anonymous-access login wall returns generic marketing copy that's
        # often long enough to beat a short-but-real og_description on length alone —
        # check for it before letting jina_text win that comparison.
        AUTHWALL_SIGNATURES = [
            "agree & join linkedin", "login to linkedin to keep in touch",
            "by clicking continue to join or sign in", "new to linkedin? join now",
            "skip to main content", "linkedin login, sign in",
        ]
        jina_is_authwall = jina_text and any(sig in jina_text.lower() for sig in AUTHWALL_SIGNATURES)

        # OG description is the post body (reliable); Jina adds depth for "See more" expansion —
        # but never prefer it over a real (if shorter) og_description when it's just authwall noise.
        combined = og_description if og_description else ""
        if jina_text and not jina_is_authwall and len(jina_text) > len(og_description):
            combined = jina_text

        # Strip LinkedIn UI boilerplate that Jina extracts
        for noise in ["Like · Comment · Share", "Like Comment Share", "1st · ", "2nd · ",
                      "3rd · ", "Connect", "Follow", "Message", "View all comments",
                      "Load more comments", "Sign in to view", "Join now to see"]:
            combined = combined.replace(noise, "")
        clean_text = re.sub(r'\s{2,}', ' ', combined).strip()

        title = og_title or jina_title or url
        print(f"[linkedin] og_title={og_title!r} jina_title={jina_title!r} jina_is_authwall={jina_is_authwall} og_description_len={len(og_description)} clean_text_len={len(clean_text)} clean_text_preview={clean_text[:150]!r} url={url}", flush=True)
        lowered = (clean_text + " " + og_title).lower()
        if any(sig in lowered for sig in AUTHWALL_SIGNATURES):
            print(f"[linkedin] authwall signature detected, skipping url={url}", flush=True)
            return {"thin_content": True, "url": url}
        # LinkedIn posts are often short (a one-liner, a quote) — use a lower bar than the
        # generic article threshold, since the authwall check above already filters garbage.
        LINKEDIN_QUALITY_THRESHOLD = 40
        if len(clean_text.strip()) < LINKEDIN_QUALITY_THRESHOLD:
            return {"thin_content": True, "url": url}
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

async def do_search(query: str, user_id: str) -> dict:
    """Semantic + full-text search over a user's saves, fused via RRF. Shared by /search
    and the recall_search MCP tool."""
    # Expand short queries before embedding to improve semantic recall; FTS uses original
    q_expanded = await expand_search_query(query)
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
            .filter("content_text", "fts", query) \
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

def do_suggestions(user_id: str) -> dict:
    """Tag/source-based search-chip suggestions. Shared by /suggestions and the
    recall_suggestions MCP tool."""
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

VALID_TAGS = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]

def do_update_tag(save_id: str, tag: str, user_id: str) -> dict:
    """Shared by PATCH /save/{id}/tag and the recall_update_tag MCP tool."""
    if tag not in VALID_TAGS:
        raise ValueError("Invalid tag")
    supabase.table("saves").update({"tag": tag}) \
        .eq("id", save_id).eq("user_id", user_id).execute()
    return {"success": True}

def do_update_title(save_id: str, title: str, user_id: str) -> dict:
    """Shared by PATCH /save/{id}/title and the recall_update_title MCP tool."""
    supabase.table("saves").update({"title": title}) \
        .eq("id", save_id).eq("user_id", user_id).execute()
    return {"success": True}

def do_delete_save(save_id: str, user_id: str) -> dict:
    """Shared by DELETE /save/{id} and the recall_delete MCP tool."""
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
