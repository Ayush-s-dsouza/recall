"""One-off backfill: re-embeds every existing save with the new RETRIEVAL_DOCUMENT
task_type so old and new embeddings are computed consistently now that search queries
use RETRIEVAL_QUERY (see CLAUDE.md Known Issue #33 and the "usdt"/"crypto" search
relevance investigation). Safe to re-run — content_text is untouched, only the
embedding column is recomputed.

Usage (run from recall-backend/):
    python scripts/reembed_saves.py            # re-embed every save
    python scripts/reembed_saves.py --limit 5  # sanity-check on the first 5 rows
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recall_core import supabase, get_embedding  # noqa: E402


def _embedding_input(row: dict) -> str:
    """Mirror the exact text construction used at save time (recall_core.py's
    process_save/process_save_fast/process_newsletter_email)."""
    title = row.get("title") or ""
    content_text = row.get("content_text") or ""
    return f"{title} {content_text}" if content_text else title


async def main(limit: int | None):
    query = supabase.table("saves").select("id, title, content_text").not_.is_("embedding", "null")
    if limit:
        query = query.limit(limit)
    rows = query.execute().data or []
    print(f"[reembed] {len(rows)} saves to re-embed", flush=True)

    failed = []
    skipped = 0
    for i, row in enumerate(rows, 1):
        text = _embedding_input(row).strip()
        if not text:
            print(f"[reembed] {i}/{len(rows)} id={row['id']} skipped (no title/content)", flush=True)
            skipped += 1
            continue
        try:
            embedding = await get_embedding(text, task_type="RETRIEVAL_DOCUMENT")
            supabase.table("saves").update({"embedding": embedding}).eq("id", row["id"]).execute()
            print(f"[reembed] {i}/{len(rows)} id={row['id']} done", flush=True)
        except Exception as e:
            print(f"[reembed] {i}/{len(rows)} id={row['id']} FAILED: {e}", flush=True)
            failed.append(row["id"])
        await asyncio.sleep(0.1)  # stay well under Gemini's rate limit

    done = len(rows) - len(failed) - skipped
    print(f"[reembed] finished: {done} re-embedded, {skipped} skipped (empty), {len(failed)} failed", flush=True)
    if failed:
        print(f"[reembed] failed ids (re-run to retry): {failed}", flush=True)


if __name__ == "__main__":
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    asyncio.run(main(limit))
