"""One-off remediation: re-runs the current save pipeline against existing Reddit and
Twitter/X saves so their channel/subreddit/author identity gets folded into content_text
(see CLAUDE.md's search-identity fix) -- previously that identity was only ever passed to
Gemini as optional context it wasn't guaranteed to preserve, so searching by subreddit name
or tweet author could silently miss saves that are obviously relevant. YouTube/Instagram
saves are handled by the existing backfill_video_content.py, not this script.

Cost note: reprocessing a tweet re-invokes the X API (pay-per-use, ~$0.005/read as of
mid-2026 -- see CLAUDE.md). Test with --limit before running broadly if you have many
tweet saves. Reddit's unauthenticated .json fallback has no equivalent cost.

Usage (run from recall-backend/):
    python scripts/backfill_source_identity.py            # reprocess every Reddit/Twitter save
    python scripts/backfill_source_identity.py --limit 3  # sanity-check on 3 rows first
"""
import asyncio
import sys
from pathlib import Path

# Windows' console defaults to cp1252, which can't encode emoji that show up in real tweet
# text -- a single unprintable character otherwise crashes the whole run (confirmed
# directly: took down a real backfill after only 4/219 rows, since even process_save's own
# exception-logging print() re-raised trying to print the emoji-containing error message).
# Not needed on Railway/Linux (UTF-8 by default) -- this is a local-dev-only safeguard.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recall_core import supabase, process_save  # noqa: E402


async def main(limit: int | None):
    rows = supabase.table("saves") \
        .select("id, user_id, url, created_at") \
        .eq("content_type", "article") \
        .execute().data or []

    def is_target(url: str) -> bool:
        url = url or ""
        return any(host in url for host in ("reddit.com", "redd.it", "twitter.com", "x.com"))

    targets = [r for r in rows if is_target(r.get("url"))]
    if limit:
        targets = targets[:limit]
    print(f"[backfill_identity] {len(targets)} Reddit/Twitter saves to reprocess", flush=True)

    stats = {"refreshed": 0, "thin_content": 0, "duplicate": 0, "error": 0}
    for i, row in enumerate(targets, 1):
        rid, url, user_id = row["id"], row["url"], row["user_id"]
        try:
            result = await process_save(url, user_id, placeholder_id=rid)
            if result.get("thin_content"):
                print(f"[backfill_identity] {i}/{len(targets)} id={rid} thin_content (url={url!r})", flush=True)
                stats["thin_content"] += 1
            elif result.get("duplicate"):
                print(f"[backfill_identity] {i}/{len(targets)} id={rid} unexpected duplicate result", flush=True)
                stats["duplicate"] += 1
            elif result.get("error"):
                print(f"[backfill_identity] {i}/{len(targets)} id={rid} error: {result.get('detail')}", flush=True)
                stats["error"] += 1
            else:
                print(f"[backfill_identity] {i}/{len(targets)} id={rid} refreshed: {result.get('title')!r}", flush=True)
                stats["refreshed"] += 1
        except Exception as e:
            print(f"[backfill_identity] {i}/{len(targets)} id={rid} EXCEPTION: {e!r}", flush=True)
            stats["error"] += 1

        await asyncio.sleep(0.3)  # gentle on X API / Gemini rate limits

    print(f"[backfill_identity] done: {stats}", flush=True)


if __name__ == "__main__":
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    asyncio.run(main(limit))
