"""One-off remediation: re-runs the current (fixed) save pipeline against every save
flagged by scan_junk_saves.py, refreshing title/content_text/embedding/tag in place.
Most flagged rows are real saves whose content_text got polluted with X/LinkedIn
login-wall or page-chrome boilerplate before the June 27 authwall-detection fix (and
the LinkedIn-redirect-resolution fix) existed — re-fetching through the current
pipeline recovers clean content for most of them, since the real post/tweet text is
usually still present alongside the boilerplate. The one non-URL test row is deleted
outright rather than reprocessed. See CLAUDE.md Known Issue #34.

Usage (run from recall-backend/):
    python scripts/reprocess_flagged_saves.py            # reprocess every flagged save
    python scripts/reprocess_flagged_saves.py --limit 3  # sanity-check on 3 rows first
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from recall_core import supabase, process_save  # noqa: E402
from scan_junk_saves import flag_reasons  # noqa: E402


async def main(limit: int | None):
    rows = supabase.table("saves") \
        .select("id, user_id, url, title, content_text, created_at") \
        .execute().data or []

    flagged = [(r, flag_reasons(r)) for r in rows]
    flagged = [(r, reasons) for r, reasons in flagged if reasons]
    if limit:
        flagged = flagged[:limit]
    print(f"[reprocess] {len(flagged)} flagged saves to handle", flush=True)

    stats = {"refreshed": 0, "thin_content": 0, "deleted": 0, "duplicate": 0, "error": 0}
    for i, (row, reasons) in enumerate(flagged, 1):
        rid, url, user_id = row["id"], row["url"], row["user_id"]

        if not url.startswith("http"):
            supabase.table("saves").delete().eq("id", rid).execute()
            print(f"[reprocess] {i}/{len(flagged)} id={rid} deleted (non-http url: {url!r})", flush=True)
            stats["deleted"] += 1
            continue

        try:
            result = await process_save(url, user_id, placeholder_id=rid)
            if result.get("thin_content"):
                # _finalize_placeholder only sets status/title — it doesn't clear stale
                # content_text/embedding left over from before this row was flagged, so
                # do that explicitly to stop it acting as a search hub.
                supabase.table("saves").update({"content_text": "", "embedding": None}).eq("id", rid).execute()
                print(f"[reprocess] {i}/{len(flagged)} id={rid} thin_content (stale content cleared)", flush=True)
                stats["thin_content"] += 1
            elif result.get("duplicate"):
                print(f"[reprocess] {i}/{len(flagged)} id={rid} unexpected duplicate result", flush=True)
                stats["duplicate"] += 1
            elif result.get("error"):
                print(f"[reprocess] {i}/{len(flagged)} id={rid} error: {result.get('detail')}", flush=True)
                stats["error"] += 1
            else:
                print(f"[reprocess] {i}/{len(flagged)} id={rid} refreshed: {result.get('title')!r}", flush=True)
                stats["refreshed"] += 1
        except Exception as e:
            print(f"[reprocess] {i}/{len(flagged)} id={rid} EXCEPTION: {e!r}", flush=True)
            stats["error"] += 1

        await asyncio.sleep(0.3)  # gentle on X API / Gemini rate limits

    print(f"[reprocess] done: {stats}", flush=True)


if __name__ == "__main__":
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    asyncio.run(main(limit))
