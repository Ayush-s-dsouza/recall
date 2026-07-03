"""One-off backfill: extracts a topic phrase + topic_embedding for every existing article
save, so query-time topic-similarity scoring (CLAUDE.md Known Issue #36) has something to
compare against. Cheaper than earlier backfills (reembed_saves.py, reprocess_flagged_saves.py)
since content_text is already stored for every ready row — no URL re-fetching needed. Safe to
re-run; only the topics/topic_embedding columns are touched.

Usage (run from recall-backend/):
    python scripts/backfill_topics.py            # backfill every article save
    python scripts/backfill_topics.py --limit 5  # sanity-check on the first 5 rows
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recall_core import supabase, get_embedding, extract_topics_async  # noqa: E402


async def main(limit: int | None):
    query = supabase.table("saves").select("id, title, content_text") \
        .eq("content_type", "article").eq("status", "ready")
    if limit:
        query = query.limit(limit)
    rows = query.execute().data or []
    print(f"[backfill_topics] {len(rows)} saves to process", flush=True)

    failed = []
    for i, row in enumerate(rows, 1):
        try:
            topics = await extract_topics_async(row.get("title") or "", row.get("content_text") or "")
            topic_embedding = await get_embedding(topics, task_type="RETRIEVAL_DOCUMENT") if topics else None
            supabase.table("saves").update(
                {"topics": topics, "topic_embedding": topic_embedding}
            ).eq("id", row["id"]).execute()
            print(f"[backfill_topics] {i}/{len(rows)} id={row['id']} topics={topics!r}", flush=True)
        except Exception as e:
            print(f"[backfill_topics] {i}/{len(rows)} id={row['id']} FAILED: {e}", flush=True)
            failed.append(row["id"])
        await asyncio.sleep(0.1)  # stay well under Gemini's rate limit

    done = len(rows) - len(failed)
    print(f"[backfill_topics] finished: {done} done, {len(failed)} failed", flush=True)
    if failed:
        print(f"[backfill_topics] failed ids (re-run to retry): {failed}", flush=True)


if __name__ == "__main__":
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    asyncio.run(main(limit))
