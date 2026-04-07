from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import httpx
from supabase import create_client
from google import genai
from google.genai import types

load_dotenv()

import sys
sys.stdout.reconfigure(line_buffering=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))


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

MEDIA_URLS = [
    ("youtube.com/watch",    "video", "YouTube videos"),
    ("youtube.com/shorts/",  "video", "YouTube Shorts"),
    ("youtu.be/",            "video", "YouTube videos"),
    ("tiktok.com/",          "video", "TikTok videos"),
    ("instagram.com/reel/",  "video", "Instagram Reels"),
    ("instagram.com/p/",     "image", "Instagram posts"),
]
QUALITY_THRESHOLD = 100  # chars — below this, content is too thin to be useful

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

def get_embedding(text: str):
    import requests
    api_key = os.getenv("GEMINI_API_KEY")
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key={api_key}",
        json={
            "model": "models/gemini-embedding-001",
            "content": {"parts": [{"text": text[:8000]}]},
            "outputDimensionality": 768
        }
    )
    data = response.json()
    return data["embedding"]["values"]

def extract_save_metadata(raw_title: str, content: str, extra_context: str = ""):
    try:
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
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
            contents=prompt
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

def extract_og_tags(html: str) -> dict:
    """Extract Open Graph and meta description tags from raw HTML."""
    import re
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
        gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        response = gemini_client.models.generate_content(
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
            ]
        )
        return response.text.strip()
    except:
        return ""

async def fetch_instagram(url: str):
    """Fetch Instagram post content via the embed endpoint (no auth required for public posts)."""
    import re
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

async def fetch_tweet(url: str):
    """Use Twitter's free oEmbed API to get tweet text and author without auth."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                "https://publish.twitter.com/oembed",
                params={"url": url, "omit_script": "true"},
                follow_redirects=True
            )
        data = res.json()
        author = data.get("author_name", "")
        import re
        # Strip HTML tags from the embed HTML to get plain tweet text
        raw_html = data.get("html", "")
        text = re.sub(r'<[^>]+>', ' ', raw_html)
        text = re.sub(r'\s+', ' ', text).strip()
        return text, author
    except:
        return "", ""

@app.post("/save")
async def save_url(req: SaveRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    existing = supabase.table("saves") \
        .select("id, title, tag, created_at") \
        .eq("user_id", user_id).eq("url", req.url) \
        .limit(1).execute()
    if existing.data:
        row = existing.data[0]
        return {"duplicate": True, "id": row["id"], "title": row["title"],
                "tag": row["tag"], "created_at": row["created_at"]}

    # --- Media URL detection: lightweight save, skip full Gemini pipeline ---
    for pattern, ctype, label in MEDIA_URLS:
        if pattern in req.url:
            try:
                async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                    r = await client.get(req.url, follow_redirects=True)
                    og = extract_og_tags(r.text[:5000])
                    raw_title = og.get("og:title") or req.url
            except:
                raw_title = req.url
            embedding = get_embedding(raw_title)
            _, tag = extract_save_metadata(raw_title, "", "")
            result = supabase.table("saves").insert({
                "user_id": user_id,
                "url": req.url,
                "title": raw_title,
                "content_text": "",
                "embedding": embedding,
                "tag": tag,
                "content_type": ctype
            }).execute()
            inserted_id = result.data[0]["id"]
            return {"success": True, "media": True, "content_type": ctype,
                    "label": label, "title": raw_title, "tag": tag, "id": inserted_id}

    is_tweet = "x.com" in req.url or "twitter.com" in req.url
    is_instagram = "instagram.com" in req.url

    extra_context = ""

    if is_tweet:
        clean_text, tweet_author = await fetch_tweet(req.url)
        title = tweet_author or req.url
    elif is_instagram:
        caption, author, thumbnail_url = await fetch_instagram(req.url)
        clean_text = caption
        title = author or "Instagram"
        # If caption is sparse, analyze the thumbnail image
        if thumbnail_url and len(clean_text) < 400:
            image_description = await analyze_image(thumbnail_url)
            if image_description:
                extra_context = f"Image: {image_description}"
                clean_text = (clean_text + "\n\n" + extra_context).strip()
    else:
        try:
            async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "Mozilla/5.0 (compatible; ReCall/1.0)"}) as client:
                response = await client.get(req.url, follow_redirects=True)
                content_text = response.text[:10000]
        except:
            content_text = ""

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
        parser.feed(content_text)
        clean_text = " ".join(t for t in parser.text if t)[:5000]

        import re
        title_match = re.search(r'<title>(.*?)</title>', content_text, re.IGNORECASE)
        title = title_match.group(1) if title_match else req.url

        # Extract Open Graph / meta tags — available even on JS-heavy sites
        og = extract_og_tags(content_text)
        og_title = og.get("og:title", "")
        og_description = og.get("og:description", "") or og.get("description", "")
        og_image = og.get("og:image", "")

        # Prefer og:title over <title> when the latter is generic
        if og_title and (not title or title == req.url):
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

        # Append extra context to stored text so full-text search also benefits
        if extra_context:
            clean_text = (clean_text + "\n\n" + extra_context)[:5000]

        # Quality gate: if there's not enough content to be useful, don't save
        if len((clean_text + extra_context).strip()) < QUALITY_THRESHOLD:
            return {"thin_content": True, "url": req.url}

    title, tag = extract_save_metadata(title, clean_text, extra_context)
    embedding = get_embedding(f"{title} {clean_text}")

    result = supabase.table("saves").insert({
        "user_id": user_id,
        "url": req.url,
        "title": title,
        "content_text": clean_text,
        "embedding": embedding,
        "tag": tag,
        "content_type": "article"
    }).execute()
    inserted_id = result.data[0]["id"]

    return {"success": True, "title": title, "tag": tag, "id": inserted_id}

@app.post("/search")
async def search(req: SearchRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Semantic search — get 20 candidates for RRF pool
    query_embedding = get_embedding(req.query)
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

@app.get("/")
async def root():
    return {"status": "ReCall backend running"}