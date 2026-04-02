"""
One-time script to backfill AI-generated titles and tags for existing saves.
Run from the recall-backend directory: python backfill_titles.py
"""

import os
import time
from dotenv import load_dotenv
from supabase import create_client
from google import genai

load_dotenv()

supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))

def extract_save_metadata(raw_title: str, content: str):
    try:
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        prompt = f"""Analyze this web content and return exactly three lines:
Line 1: A concise, accurate title (max 8 words) describing what this specific content is about — not the platform name
Line 2: The author's full name, or organisation name if no individual author. Write "Unknown" if not found.
Line 3: One category from: Tech, Product, Business, Finance, Health, Personal, Other

Raw title: {raw_title}
Content: {content[:1500]}

Respond with exactly three lines, nothing else."""
        response = client.models.generate_content(
            model="gemini-2.5-flash-preview-04-17",
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
    except Exception as e:
        print(f"  Gemini error: {e}")
        return raw_title, "Other"

def main():
    print("Fetching all saves...")
    result = supabase.table("saves").select("id, title, content_text, tag, url").execute()
    saves = result.data
    print(f"Found {len(saves)} saves to backfill.\n")

    for i, save in enumerate(saves):
        sid = save["id"]
        raw_title = save["title"] or save["url"]
        content = save["content_text"] or ""

        print(f"[{i+1}/{len(saves)}] {raw_title[:60]}...")
        new_title, new_tag = extract_save_metadata(raw_title, content)
        print(f"  → {new_title} [{new_tag}]")

        supabase.table("saves").update({
            "title": new_title,
            "tag": new_tag
        }).eq("id", sid).execute()

        # Avoid hitting Gemini rate limits
        time.sleep(1)

    print(f"\nDone. {len(saves)} saves updated.")

if __name__ == "__main__":
    main()
