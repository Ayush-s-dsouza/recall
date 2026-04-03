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

def get_user_id(token: str):
    user = supabase.auth.get_user(token)
    return user.user.id

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
            print(f"[analyze_image] status={res.status_code} mime={mime_type} size={len(image_bytes)}")
            # Reject if too small (likely an error page) or clearly not an image
            if len(image_bytes) < 1000:
                print(f"[analyze_image] rejected: too small")
                return ""
            if not mime_type.startswith("image/") and mime_type not in ("application/octet-stream",):
                print(f"[analyze_image] rejected: bad mime type")
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

        print(f"[instagram] embed status={res.status_code} html_len={len(html)}")

        # Extract caption — try multiple patterns since Instagram changes their HTML structure
        caption = ""
        caption_patterns = [
            # JSON data embedded in script tags (most reliable)
            r'"edge_media_to_caption"\s*:\s*\{"edges"\s*:\s*\[\{"node"\s*:\s*\{"text"\s*:\s*"((?:[^"\\]|\\.)*)"\}',
            r'"caption"\s*:\s*\{"edges"\s*:\s*\[\{"node"\s*:\s*\{"text"\s*:\s*"((?:[^"\\]|\\.)*)"\}',
            r'"text"\s*:\s*"((?:[^"\\]|\\.){30,})"',  # any long text string in JSON
            # HTML class patterns (older embed versions)
            r'class="[^"]*Caption[^"]*"[^>]*>.*?<span[^>]*>(.*?)</span>',
            r'<div[^>]+data-testid="post-comment-root"[^>]*>.*?<span[^>]*>(.*?)</span>',
        ]
        for pattern in caption_patterns:
            m = re.search(pattern, html, re.DOTALL)
            if m:
                raw = m.group(1)
                # Unescape JSON unicode escapes and strip HTML tags
                raw = raw.replace('\\n', ' ').replace('\\"', '"').replace('\\u0026', '&')
                caption = re.sub(r'<[^>]+>', '', raw).strip()
                if len(caption) > 10:
                    print(f"[instagram] caption matched pattern: {pattern[:50]}")
                    break

        # Extract username
        author = ""
        for pattern in [
            r'"username"\s*:\s*"([^"]+)"',
            r'"owner"\s*:\s*\{"username"\s*:\s*"([^"]+)"',
            r'class="[^"]*UsernameText[^"]*"[^>]*>([^<]+)<',
        ]:
            m = re.search(pattern, html)
            if m:
                author = m.group(1)
                break

        # Extract thumbnail
        thumbnail_url = ""
        for pattern in [
            r'"thumbnail_src"\s*:\s*"(https://[^"]+)"',
            r'"display_url"\s*:\s*"(https://[^"]+)"',
            r'<img[^>]+src="(https://[^"]+(?:cdninstagram|fbcdn)[^"]+)"',
        ]:
            m = re.search(pattern, html)
            if m:
                thumbnail_url = m.group(1).replace('\\/', '/')
                break

        print(f"[instagram] author={author!r} caption_len={len(caption)} thumbnail={'yes' if thumbnail_url else 'no'}")
        print(f"[instagram] caption_preview={caption[:100]!r}")
        return caption, author, thumbnail_url
    except Exception as e:
        print(f"[instagram] embed fetch failed: {e}")
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
            print(f"[instagram] image_description={image_description!r}")
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

        print(f"[save] url={req.url}")
        print(f"[save] clean_text length={len(clean_text)}")
        print(f"[save] og_title={og_title!r}")
        print(f"[save] og_description={og_description!r}")
        print(f"[save] og_image={og_image!r}")

        # Prefer og:title over <title> when the latter is generic
        if og_title and (not title or title == req.url):
            title = og_title

        # Build extra context: OG description + vision analysis for sparse pages
        extra_parts = []
        if og_description:
            extra_parts.append(og_description)
        if og_image and len(clean_text) < 400:
            print(f"[save] attempting image analysis: {og_image[:80]}")
            image_description = await analyze_image(og_image)
            print(f"[save] image_description={image_description!r}")
            if image_description:
                extra_parts.append(f"Image: {image_description}")
        extra_context = "\n".join(extra_parts)
        print(f"[save] extra_context={extra_context!r}")

        # Append extra context to stored text so full-text search also benefits
        if extra_context:
            clean_text = (clean_text + "\n\n" + extra_context)[:5000]

    title, tag = extract_save_metadata(title, clean_text, extra_context)
    embedding = get_embedding(f"{title} {clean_text}")

    supabase.table("saves").insert({
        "user_id": user_id,
        "url": req.url,
        "title": title,
        "content_text": clean_text,
        "embedding": embedding,
        "tag": tag
    }).execute()

    return {"success": True, "title": title, "tag": tag}

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

    # Full-text search over content + title
    try:
        fts_result = supabase.table("saves") \
            .select("id, url, title, tag") \
            .eq("user_id", user_id) \
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

    for rank, row in enumerate(semantic_result.data):
        rid = row["id"]
        scores[rid] = scores.get(rid, 0) + 1 / (K + rank + 1)
        metadata[rid] = row

    for rank, row in enumerate(fts_rows):
        rid = row["id"]
        scores[rid] = scores.get(rid, 0) + 1 / (K + rank + 1)
        if rid not in metadata:
            metadata[rid] = row

    # Normalize scores to 0–1 so the frontend % display stays meaningful
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:5]
    max_score = ranked[0][1] if ranked else 1
    results = []
    for rid, score in ranked:
        row = metadata[rid]
        row["similarity"] = score / max_score
        results.append(row)

    return {"results": results}

@app.get("/")
async def root():
    return {"status": "ReCall backend running"}