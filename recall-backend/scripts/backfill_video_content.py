"""One-off remediation: re-runs the current save pipeline against every existing
video/image save, replacing the empty content_text/title-only embedding they got before
this round with real content (YouTube transcripts, Instagram captions) and real
topics/topic_embedding — see CLAUDE.md's video-support round. TikTok saves are skipped
entirely: TikTok fetching (both a plain scrape and yt-dlp) was confirmed via direct
testing to fail outright from cloud/datacenter IPs without user-supplied login cookies,
so reprocessing them would just leave them exactly as thin as before.

Usage (run from recall-backend/):
    python scripts/backfill_video_content.py            # reprocess every video/image save
    python scripts/backfill_video_content.py --limit 3  # sanity-check on 3 rows first
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recall_core import supabase, process_save  # noqa: E402


async def main(limit: int | None):
    rows = supabase.table("saves") \
        .select("id, user_id, url, title, content_type, created_at") \
        .in_("content_type", ["video", "image"]) \
        .execute().data or []

    targets = [r for r in rows if "tiktok.com" not in (r.get("url") or "")]
    skipped_tiktok = len(rows) - len(targets)
    if limit:
        targets = targets[:limit]
    print(f"[backfill_video] {len(targets)} video/image saves to reprocess "
          f"({skipped_tiktok} TikTok saves skipped, see module docstring)", flush=True)

    stats = {"refreshed": 0, "thin_content": 0, "duplicate": 0, "error": 0}
    for i, row in enumerate(targets, 1):
        rid, url, user_id = row["id"], row["url"], row["user_id"]
        try:
            result = await process_save(url, user_id, placeholder_id=rid)
            if result.get("thin_content"):
                print(f"[backfill_video] {i}/{len(targets)} id={rid} thin_content (url={url!r})", flush=True)
                stats["thin_content"] += 1
            elif result.get("duplicate"):
                print(f"[backfill_video] {i}/{len(targets)} id={rid} unexpected duplicate result", flush=True)
                stats["duplicate"] += 1
            elif result.get("error"):
                print(f"[backfill_video] {i}/{len(targets)} id={rid} error: {result.get('detail')}", flush=True)
                stats["error"] += 1
            else:
                print(f"[backfill_video] {i}/{len(targets)} id={rid} refreshed: {result.get('title')!r}", flush=True)
                stats["refreshed"] += 1
        except Exception as e:
            print(f"[backfill_video] {i}/{len(targets)} id={rid} EXCEPTION: {e!r}", flush=True)
            stats["error"] += 1

        await asyncio.sleep(0.3)  # gentle on Gemini/YouTube rate limits

    print(f"[backfill_video] done: {stats}", flush=True)


if __name__ == "__main__":
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    asyncio.run(main(limit))
