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

def auto_tag(title: str, content: str):
    try:
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        prompt = f"Classify this content into exactly one category: Tech, Product, Business, Finance, Health, Personal, Other. Content: {title} {content[:500]}. Reply with just the category word, nothing else."
        response = client.models.generate_content(
            model="gemini-2.5-flash-preview-04-17",
            contents=prompt
        )
        tag = response.text.strip()
        valid_tags = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]
        return tag if tag in valid_tags else "Other"
    except:
        return "Other"

@app.post("/save")
async def save_url(req: SaveRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
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

    tag = auto_tag(title, clean_text)
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

    query_embedding = get_embedding(req.query)

    result = supabase.rpc("match_saves", {
        "query_embedding": query_embedding,
        "match_user_id": user_id,
        "match_count": 5
    }).execute()

    return {"results": result.data}

@app.get("/")
async def root():
    return {"status": "ReCall backend running"}