"""One-off, read-only report: scans every save for signs of content-free "junk" that
pollutes search as an embedding-space hub (a non-URL test row, a save whose title
extraction produced nothing but the URL itself, or content that's actually X/LinkedIn's
own login-wall or interstitial page rather than the real content). Never deletes
anything — prints a report for manual review. See CLAUDE.md Known Issue #33 and the
"usdt"/"crypto" search relevance investigation.

Usage (run from recall-backend/):
    python scripts/scan_junk_saves.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from recall_core import supabase, X_JUNK_SIGNATURES  # noqa: E402

# Mirrors the LinkedIn authwall signature list defined inline in recall_core.py's
# process_save() (LinkedIn branch) — duplicated here for scanning since it's local to
# that function, not a module-level export.
LINKEDIN_AUTHWALL_SIGNATURES = [
    "agree & join linkedin", "login to linkedin to keep in touch",
    "by clicking continue to join or sign in", "new to linkedin? join now",
    "skip to main content", "linkedin login, sign in",
]

JUNK_SIGNATURES = X_JUNK_SIGNATURES + LINKEDIN_AUTHWALL_SIGNATURES


def flag_reasons(row: dict) -> list[str]:
    reasons = []
    url = row.get("url") or ""
    title = row.get("title") or ""
    content = (row.get("content_text") or "").lower()

    if not url.startswith("http"):
        reasons.append("non-http url")
    if title and title == url:
        reasons.append("title == url (extraction failed)")
    if "linkedin.com/safety/go" in url:
        reasons.append("unresolved linkedin redirect wrapper")
    hit = next((sig for sig in JUNK_SIGNATURES if sig in content), None)
    if hit:
        reasons.append(f'content matches junk signature: "{hit}"')

    return reasons


def main():
    rows = supabase.table("saves") \
        .select("id, user_id, url, title, content_text, created_at") \
        .execute().data or []

    print(f"[scan] {len(rows)} total saves checked", flush=True)
    flagged = []
    for row in rows:
        reasons = flag_reasons(row)
        if reasons:
            flagged.append((row, reasons))

    print(f"[scan] {len(flagged)} flagged\n", flush=True)
    for row, reasons in flagged:
        print(f"id={row['id']}  created_at={row.get('created_at')}", flush=True)
        print(f"  url:   {row.get('url')}", flush=True)
        print(f"  title: {row.get('title')}", flush=True)
        print(f"  reasons: {', '.join(reasons)}", flush=True)
        print(flush=True)


if __name__ == "__main__":
    main()
