# ReCall — Complete Project Context

> **Keep this file up to date.** Every significant change to the stack, features, deployment, or known issues should be reflected here. This is the sole source of truth read at the start of every Claude Code session.

---

## Local Decision Log

The repo root also has `DECISION_LOG.md` — a personal, local-only record of the tradeoffs, rationale, and macro theses behind decisions on this project, kept for grounding future interview/portfolio narratives in granular truth. It is **not committed** (excluded via `.git/info/exclude`, same precedent as other local Claude Code artifacts in this repo).

**Ambient logging — do this proactively, don't wait to be asked:** whenever the user explains the "why" behind a feature, fix, or product decision — a rationale, a rejected alternative, a tradeoff, a strategic belief — during any session, append or update an entry in `DECISION_LOG.md`. This covers both tactical decisions (a specific tradeoff on a specific feature) and macro theses (a belief that shapes multiple decisions, e.g. "latency is a relevance signal"). Skip routine bug fixes/refactors with no real "why" behind them. See `DECISION_LOG.md`'s own header for entry format and what's log-worthy.

---

## What This Is

ReCall is a PWA (Progressive Web App) for semantic search over saved internet content. Users save URLs via Android's Share Sheet (or by pasting), and search their entire save history using natural language. Built as a portfolio project for Google APM applications.

**Tagline:** "Your saved internet, finally searchable."

---

## Live URLs

| Service | URL |
|---|---|
| Frontend (Vercel) | https://recall-iota-six.vercel.app |
| Backend (Railway) | https://recall-production-9941.up.railway.app |
| Supabase project | https://ompfoouatzknuidnccsz.supabase.co |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 8 (PWA) |
| Backend | Python + FastAPI |
| Database | Supabase (Postgres + pgvector) |
| Auth | Supabase Auth with Google OAuth |
| Embeddings | Gemini `gemini-embedding-001` (768 dims, via direct REST — NOT the SDK), asymmetric `taskType` (`RETRIEVAL_DOCUMENT` at save time, `RETRIEVAL_QUERY` at search time — see Known Issue #34) |
| AI tagging | Gemini `gemini-2.5-flash` (via `google-genai` SDK) |
| X/Twitter content | X API v2 (OAuth 2.0 PKCE for bookmark import; app-only Bearer token for single-tweet reads), pay-per-use billing |
| Reddit content | Reddit's official OAuth API (`oauth.reddit.com`), app-only `client_credentials` grant — fetches post + top comments |
| Newsletter content | CloudMailin inbound-email webhook (free tier) — forwarded/auto-forwarded emails parsed with `beautifulsoup4` |
| Analytics | PostHog (`posthog-js` — frontend only) |
| Error monitoring | Sentry (`@sentry/react` frontend, `sentry-sdk[fastapi]` backend) |
| Rate limiting | slowapi (per-IP, on `/save`, `/search`, and ~20 other mutating/expensive routes as of Known Issue #39) + a hand-rolled `cachetools.TTLCache`-based IP-keyed middleware for the mounted MCP OAuth sub-app (`/register`, `/token`, `/authorize`, `/revoke`), which slowapi's route decorators can't reach since it's a separately-mounted ASGI app |
| Frontend deploy | Vercel |
| Backend deploy | Railway (Nixpacks builder) |

---

## Folder Structure

```
ReCall/
├── CLAUDE.md                   ← this file
├── CONTRIBUTING.md              ← staging/production branch workflow + env var reference (Vercel `staging` branch vs `main`)
├── vercel.json                 ← SPA fallback rewrites (lives at root; Vercel root dir = recall-frontend)
├── .gitignore
├── .github/workflows/keepalive.yml  ← cron ping to Railway's `GET /` every 10min, keeps the backend warm (Known Issue #38)
├── recall-frontend/            ← React PWA
│   ├── src/
│   │   ├── App.jsx             ← entire frontend (single component file)
│   │   ├── main.jsx            ← React entry point
│   │   ├── posthog-lazy.js     ← lazy-loading proxy around posthog-js (queues calls until the real SDK chunk loads, keeps it off the critical render path)
│   │   ├── index.css           ← global CSS variables, base styles, shimmer keyframes
│   │   └── App.css             ← Vite boilerplate, not actively used by the app
│   ├── public/
│   │   ├── manifest.json       ← PWA manifest + Share Target config
│   │   ├── favicon.svg         ← lightning bolt logo (purple gradient, detailed SVG)
│   │   └── icon.svg            ← gray square with white brackets + center dot (PWA home screen icon)
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── .env                    ← NEVER commit; see env vars section below
└── recall-backend/
    ├── main.py                 ← FastAPI app: REST routes (thin wrappers) + mounts mcp_server.py
    ├── recall_core.py          ← shared business logic (do_* functions, process_save, supabase client) — used by both main.py and mcp_server.py
    ├── mcp_server.py           ← remote MCP server: OAuth 2.1 provider + 6 MCP tools (Claude/ChatGPT connector)
    ├── sql/                    ← hand-run migrations (no migration tool); 001 = MCP OAuth tables, 002-004 = fixes, 012 = saves(user_id,url) unique constraint (Known Issue #38), 013 = lock down save_folders RLS, 014 = RLS hardening for push_subscriptions/MCP OAuth tables + saves owner-policy reaffirmation (Known Issue #39)
    ├── scripts/                ← one-off maintenance scripts, run manually (not part of the deployed app) — reembed_saves.py, scan_junk_saves.py, reprocess_flagged_saves.py (see Known Issue #34), backfill_topics.py (see Known Issue #36)
    ├── requirements.txt
    ├── Procfile                ← `web: uvicorn main:app --host 0.0.0.0 --port $PORT`
    ├── railway.json            ← Nixpacks build + start command
    └── .env                    ← NEVER commit; see env vars section below
```

---

## Environment Variables

### Frontend — `recall-frontend/.env`

```
VITE_SUPABASE_URL=https://ompfoouatzknuidnccsz.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key — safe for client>
VITE_BACKEND_URL=http://127.0.0.1:8000          # local dev; set to Railway URL in Vercel dashboard
VITE_SENTRY_DSN=<Sentry frontend DSN — safe for client>
VITE_POSTHOG_KEY=<PostHog project API key — safe for client>
VITE_TWITTER_CLIENT_ID=<X OAuth 2.0 app Client ID — safe for client, used to build the authorize URL>
VITE_VAPID_PUBLIC_KEY=<same value as backend's VAPID_PUBLIC_KEY — public-safe, used by PushManager.subscribe()>
VITE_EMAIL_INBOUND_ADDRESS=<shared CloudMailin inbound address shown in Settings for newsletter forwarding — public-safe, it's the address you hand out>
```

**On Vercel**, set `VITE_BACKEND_URL` to `https://recall-production-9941.up.railway.app` via the Vercel environment variable dashboard — do NOT hardcode it. `VITE_SENTRY_DSN`, `VITE_POSTHOG_KEY`, `VITE_TWITTER_CLIENT_ID`, `VITE_VAPID_PUBLIC_KEY`, and `VITE_EMAIL_INBOUND_ADDRESS` are also set in Vercel dashboard. All are public-safe by design.

### Backend — `recall-backend/.env`

```
SUPABASE_URL=https://ompfoouatzknuidnccsz.supabase.co
SUPABASE_SERVICE_KEY=<service role key — NEVER expose to client>
GEMINI_API_KEY=<Gemini API key>
SENTRY_DSN=<Sentry backend DSN>
CORS_ORIGINS=https://recall-iota-six.vercel.app,http://localhost:5173
AUTH_VERIFY_MODE=<"network" (default) or "local" — see Known Issue #38. "network" keeps calling Supabase's GoTrue /auth/v1/user endpoint on every request but also canary-logs a local JWT-verification result alongside it for comparison; only switch to "local" (skips the network round-trip entirely) once canary logs confirm the two always agree>
BACKEND_PUBLIC_URL=https://recall-production-9941.up.railway.app   # mcp_server.py OAuth issuer/resource URL; defaults to http://localhost:8000 for local dev
FRONTEND_URL=https://recall-iota-six.vercel.app                    # where mcp_server.py's authorize() redirects for consent; defaults to http://localhost:5173
TWITTER_CLIENT_ID=<X OAuth 2.0 app Client ID — bookmark import>
TWITTER_CLIENT_SECRET=<X OAuth 2.0 app Client Secret — NEVER expose to client>
TWITTER_BEARER_TOKEN=<X API app-only Bearer token — single-tweet save lookups>
REDDIT_CLIENT_ID=<optional — Reddit "script" app Client ID; unset until Reddit approves API access, see Known Issue #30>
REDDIT_CLIENT_SECRET=<optional — Reddit "script" app Client Secret — NEVER expose to client>
REDDIT_USER_AGENT=<descriptive UA Reddit's API requires, e.g. "ReCall/1.0 by u/yourusername" — used by both the OAuth path and the .json fallback>
VAPID_PUBLIC_KEY=<Web Push VAPID public key — also mirrored to frontend as VITE_VAPID_PUBLIC_KEY>
VAPID_PRIVATE_KEY=<Web Push VAPID private key — NEVER expose to client>
VAPID_SUBJECT=mailto:<contact email, required by the Web Push spec>
EMAIL_WEBHOOK_SECRET=<shared secret embedded as the password in CloudMailin's configured target webhook URL — verifies inbound email requests are genuinely from CloudMailin>
```

**On Railway**, these are set as environment variables in the Railway dashboard. `CORS_ORIGINS` is comma-separated — update if the frontend domain ever changes. The three X API vars are all from the same X Developer Portal app; if unset, both import paths fall back gracefully (bookmark import shows a 503 + bookmarklet fallback; single-tweet save degrades to Jina/OG/syndication-API fallbacks — see Import X Bookmarks (#14) and Known Issue #23). The three Reddit vars are from a single Reddit "script" app; if unset, Reddit saves degrade to `thin_content` rather than erroring (see "Reddit post + comment fetching" below and Known Issue #30). The three VAPID vars power Web Push (see "Web Push notifications" #1c) — generate once with `npx web-push generate-vapid-keys`; if unset, `send_save_ready_push()` silently no-ops (no save behavior is affected either way). `EMAIL_WEBHOOK_SECRET` powers newsletter saving (see "Newsletter saving via email forwarding" below and Known Issue #32) — if unset, `/webhooks/email-inbound` rejects every request with 401.

---

## Backend API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/save` | Save a URL — returns a pending placeholder almost instantly; real title/tag land via background enrichment (see "Background save enrichment") |
| `POST` | `/search` | Hybrid semantic + FTS search |
| `POST` | `/suggestions` | Personalised search chip suggestions |
| `PATCH` | `/save/{id}/title` | Update a save's display title |
| `PATCH` | `/save/{id}/tag` | Update a save's category tag (kept for MCP backward compat; tag is still auto-generated but not shown in UI) |
| `PATCH` | `/save/{id}/folders` | Set folder memberships for a save (replaces all; empty array = unfiled) |
| `DELETE` | `/save/{id}` | Delete a save |
| `GET` | `/folders` | List user's folders with save counts |
| `POST` | `/folders` | Create a folder |
| `PATCH` | `/folders/{id}` | Rename a folder |
| `DELETE` | `/folders/{id}` | Delete a folder (cascade removes memberships; saves unaffected) |
| `DELETE` | `/account` | Delete all user saves + auth account |
| `POST` | `/push/subscribe` | Register a Web Push subscription for the signed-in user |
| `POST` | `/push/unsubscribe` | Remove a Web Push subscription |
| `POST` | `/webhooks/email-inbound` | CloudMailin inbound-email webhook — receives forwarded newsletters (see "Newsletter saving via email forwarding") |
| `GET` | `/` | Health check |

All mutating endpoints verify the Supabase JWT and enforce `user_id` ownership before touching any row.

### Remote MCP server (Claude/ChatGPT connector)

Mounted at backend root by `mcp_server.py` (see CLAUDE.md "Folder Structure" and "Supabase Schema" above). OAuth 2.1 endpoints come from the `mcp` SDK itself: `/register`, `/authorize`, `/token`, `/revoke`, `/.well-known/oauth-authorization-server`. The actual MCP protocol endpoint (what gets pasted into Claude/ChatGPT as a custom connector) is `/mcp`.

Bridge endpoints (ours, not the SDK's):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp/authorize/complete` | Frontend calls this after the user approves consent — verifies the Supabase session, mints an MCP auth code, returns the URL to redirect back to Claude/ChatGPT |
| `GET` | `/mcp/connections?token=` | List the user's active (non-revoked) connected apps |
| `POST` | `/mcp/connections/{client_id}/revoke` | Disconnect an app |

The 6 MCP tools (`recall_search`, `recall_save`, `recall_suggestions`, `recall_update_tag`, `recall_update_title`, `recall_delete`) call the same `do_*`/`process_save` functions as the REST API, resolving `user_id` from the OAuth access token instead of a body token.

---

## How Each Major Feature Works

### 1. Save a URL

`/save` returns almost instantly with a placeholder row; the expensive fetch/Gemini/embedding pipeline runs in the background and the real title/tag land moments later via Realtime (or a polling fallback) — see "Background save enrichment" (#1b) below for the full mechanics. Summary of the immediate request/response:

**Frontend (`App.jsx` → `handleSave(url, fromShareSheet = false)`)**
1. Validates URL starts with `http://` or `https://`; shows error and returns early if not
2. Immediately sets an optimistic `saveReceipt` with `{ url, optimistic: true }` — renders a shimmer card at once
3. Button text cycles through `["Fetching...", "Reading...", "Analyzing...", "Almost there..."]` every 800 ms via a `useEffect` on `loading`
4. POSTs `{ url, token }` to `BACKEND/save` (45s client-side `AbortController` timeout — a safety net, not the normal path, since the response itself comes back in well under a second)
5. **On duplicate** (`data.duplicate === true`): sets receipt to `{ ...data, duplicate: true }` — shows amber "Already in ReCall" card with original save date. No chime, no re-save.
6. **On pending** (`data.pending === true`, the normal case): fires posthog `save_confirmed` immediately (the reliable activation/volume signal — independent of enrichment timing or whether the user sticks around), then clears input, sets `saveReceipt` to a pending state — shows "Saved ✓" immediately with the title/tag area shimmering, plus copy telling the user they can leave ("Feel free to close the app, we'll notify you when it's ready" if push is enabled, otherwise "go on with your day, it'll update here on its own"). Bumps `totalSaveCount` right away since the row exists in the DB. Chime/vibrate/milestone-tracking/posthog `url_saved` are deferred until enrichment actually finishes (`finalizeSave`, #1b) — `url_saved` is a secondary "stayed to see it finish" signal, not the activation metric (it undercounts real saves whenever the user navigates away before enrichment resolves, which the save flow explicitly invites the user to do).
7. **On failure**: clears receipt, shows red error message

**Backend (`main.py` → `POST /save` → `process_save_fast`)**
1. Verifies JWT → `user_id` — as of Known Issue #38, this is local JWT verification (no network round-trip), not a call to Supabase's Auth API
2. Resolves any LinkedIn `safety/go` redirect (`resolve_linkedin_redirect`, see Known Issue #25)
3. Cheap no-network media-type guess from `MEDIA_URLS` (string match only, e.g. YouTube/TikTok/Instagram Reel patterns)
4. **Duplicate check + placeholder insert are one round-trip** (Known Issue #38): `INSERT ... ON CONFLICT (user_id, url) DO NOTHING` (`status: "pending"`, title = `get_source_label(url)`, `tag: null`, `embedding: null`). An empty result means the row already existed — only then does a follow-up `SELECT` fetch its details for `{ duplicate: True, id, title, tag, created_at }`. Otherwise returns `{ success: True, pending: True, id, title, url, content_type, label }` — this is the response the frontend actually sees.
5. Kicks off `_enrich_in_background(url, user_id, placeholder_id)` as an `asyncio.create_task` — fire-and-forget, keeps running after the response is sent (same pattern as the bookmark import job's `run_import_job`)

### 1b. Background save enrichment

`_enrich_in_background` calls `process_save(url, user_id, placeholder_id=...)` — the **same function** that does the actual heavy lifting (tweet/Instagram/LinkedIn/article fetch, Gemini vision, `extract_save_metadata`, `extract_topics` (see Known Issue #36), `get_embedding`), unchanged from before this feature existed. The only difference when `placeholder_id` is set:
- Skips the duplicate check (already done by `process_save_fast`)
- `UPDATE`s the placeholder row instead of `INSERT`ing a new one, setting `status: "ready"` once real data lands
- The "thin content" early-return points (deleted/protected tweet, unresolved LinkedIn redirect, LinkedIn authwall, LinkedIn/generic quality threshold — see Known Issue #34) now finalize the placeholder as `status: "ready"` with its best-effort title before returning, **instead of silently rejecting the save** — every link the user saves now ends up as a real row, even a weak one they can delete manually. (Deliberate behavior change from the old reject-outright thin-content handling.)
- On success, calls `send_save_ready_push()` (see #1c) — only for this fast-path flow, not bookmark import or MCP saves, to avoid notification spam on a 500-item import

`process_save` (no `placeholder_id`) is still called directly, unchanged, by the bookmark import job (`main.py`) and the `recall_save` MCP tool (`mcp_server.py`) — both want a final answer in one synchronous round trip and have no progressive UI to show a pending state, so they intentionally skip the fast path.

**Realtime resolution (`App.jsx`)**: one `saves-<uid>` Supabase Realtime channel (subscribed once per signed-in session) listens for `UPDATE` events on `saves` where `status` flips to `ready`, and calls `finalizeSave(row)` — which patches the matching Today's-list row in place, and additionally fires the chime/vibrate/milestone/posthog/related-saves logic *only if* that row is still the active receipt on screen. `finalizeSave` is accessed through `finalizeSaveRef` (a "latest ref" pattern) so the long-lived channel subscription never acts on a stale closure of `saveReceipt`/`first5Count`/`onboardingStep`. A one-shot 20s `setTimeout` fallback re-fetches the row directly in case Realtime is ever misconfigured/off — requires the `saves` table to have Realtime enabled in the Supabase dashboard (Database → Publications → `supabase_realtime` → add `saves`).

**`do_search`/`do_suggestions`** both filter out `status != "ready"` rows so a still-enriching placeholder never surfaces in search results or tag/source suggestion tallies.

### 1c. Web Push notifications

Since saves now resolve their title in the background, ReCall also offers a Web Push notification (`Saved "<title>"` / `from <source>`) for when enrichment finishes — useful if the user has closed the app entirely, which the in-app Realtime update obviously can't reach.

- **First service worker in this project** — `recall-frontend/public/sw.js`. Handles `push` (shows the notification) and `notificationclick` (focuses an existing ReCall window or opens a new one).
- **Opt-in**: Settings (⚙) → "Notify me when saves finish" (`enableSaveNotifications` in `App.jsx`). Requests `Notification.requestPermission()`, registers the SW, subscribes via `PushManager`, POSTs the subscription to `/push/subscribe`. A separate effect silently re-confirms/re-subscribes on every load if permission was already granted in a prior session, without re-prompting.
- **iOS gate**: Apple only supports Web Push on iOS 16.4+ for PWAs already added to the Home Screen (`isStandalone`) — a plain Safari tab can never receive push, full stop. `pushSupported = "serviceWorker" in navigator && "PushManager" in window && (!isIOS || isStandalone)` hides the toggle entirely rather than offering a prompt that can't work.
- **Backend** (`recall_core.py` → `send_save_ready_push`): looks up the user's `push_subscriptions` rows, sends via `pywebpush` with VAPID auth, deletes the subscription row on a `404`/`410` (expired). Wrapped in try/except everywhere — a push failure must never affect the save itself.
- **Windows gotcha discovered during testing**: Windows has its own per-app notification toggle (Settings → System → Notifications) independent of the browser's own `Notification.permission` state. If that's off, Chrome never shows anything — not a toast, not even silently in the Action Center — regardless of whether the push was sent successfully server-side. The DevTools Application → Service Workers → "Push" test button (simulates a push with no network involved) is the fastest way to isolate "our code is broken" from "this machine's OS/browser notification pipeline is misconfigured."

### 2. Save Receipt Card

While `status` is `pending`, the title area shows a shimmer placeholder instead of any text — **never a real-looking title that later changes**, since that reads as a bug rather than progressive loading. Once enrichment resolves, the card shows:
- **Folder pills + "+ Folder" button** — shows which folders the save is in. Tapping "+ Folder" (or any existing folder pill) opens the folder picker bottom sheet.
- **Title** — editable via ✎ pencil icon → input + green ✓ button. Confirming PATCHes `/save/{id}/title`, updates the Today list, plays chime + vibrates.
- **URL** + **"Saved ✓"** footer
- **"← Return to [Source]"** link — shown only when the save was triggered via the share sheet. Implemented as `<a href="twitter://timeline">` (not programmatic `window.location.href`) — see Known Issues #13.

Receipt clears when the user starts typing a new URL into the input.

### 3. Today's Saves

A scrollable list below the save form showing all saves from the current calendar day. Fetched directly from Supabase (anon key + RLS) — no backend endpoint needed:
```js
supabase.from("saves").select("id, url, title, tag, content_type, status")
  .gte("created_at", today.toISOString())
  .order("created_at", { ascending: false }).limit(20)
```
Refreshed on: user sign-in, after each successful save (immediately on the pending placeholder, then again in-place via the `saves-<uid>` Realtime channel once `status` flips to `ready` — see "Background save enrichment"). Rows with `status === "pending"` render a shimmer in place of the title/tag text instead of the real values.

Each card shows tag + title + source label. Trash icon (🗑) expands the card to a confirmation row ("Remove from ReCall?" + Delete/Cancel). Deleting calls `DELETE /save/{id}`, filters from state, and clears the receipt if it matches.

### 4. Search

**Frontend (`App.jsx` → `handleSearch(overrideQuery?)`)**
1. Accepts an optional `overrideQuery` parameter to avoid stale closure when called from chip clicks (same pattern as `fromShareSheet` in save flow)
2. Resets `selectedSource`, `selectedTag`, `displayCount` (to 5) on each new search
3. Writes the query to recent searches (`localStorage` key `recall_recent_searches`, max 5, newest-first, deduped)
4. POSTs `{ query, token }` to `BACKEND/search`
5. Persists last query + results to `sessionStorage` (`recall_last_query`, `recall_last_results`) — restored on tab revisit within the same session
6. Renders result cards with tag, date, title, 3-line excerpt, source label — no raw match %
7. Two filter dropdowns (Source + Tag) replace the old pill row — only shown when >1 distinct value exists in results; each resets `displayCount`
8. "Show more" button reveals results 5 at a time (`displayCount` state); pagination applies within the active filter combination

**Backend (`recall_core.py` → `do_search()`, shared by `POST /search` and the `recall_search` MCP tool)**

Hybrid search with a magnitude-aware fusion score (replaced pure rank-based RRF — see Known Issue #33). As of round 4 (Known Issue #36), there is no generative LLM call anywhere in this path — only one embedding API call plus fast Postgres queries:
1. Embeds the raw query using `get_embedding()` (`task_type="RETRIEVAL_QUERY"`) — no query-expansion step (round 3's `expand_search_query()` was removed, see Known Issue #36)
2. **Semantic search**: Supabase RPC `match_saves`, called with `match_threshold: SEARCH_MIN_SEMANTIC_SIMILARITY` (0.60) and the same query embedding passed again as `topic_query_embedding` — rows below the content-similarity threshold are excluded by the RPC itself and never returned, so a search can legitimately come back with fewer than 20 (or zero) semantic matches. Returns both a `similarity` column (query vs. full content) and a `topic_similarity` column (query vs. a precomputed topic/entity phrase, see Known Issue #36).
3. **Full-text search**: `saves` table, selects `id, url, title, tag, created_at, content_text`, limit 20, ordered by `created_at desc` — no relevance floor here since a literal keyword match is inherently a real signal, unlike a weak semantic neighbor
4. **Topic floor**: semantic rows with a nonzero `topic_similarity` below `SEARCH_TOPIC_MIN_SIMILARITY` (0.58) are dropped before fusion — see Known Issue #36 for why an additive weight alone wasn't enough
5. **Fusion**: `score = SEARCH_SEMANTIC_WEIGHT * similarity + SEARCH_TOPIC_WEIGHT * topic_similarity + SEARCH_FTS_WEIGHT * (1 / (1 + fts_rank))`, summed per save ID when a save appears in both the semantic and FTS lists — so the intersection is still boosted. Weights: `SEARCH_SEMANTIC_WEIGHT = 1.0`, `SEARCH_TOPIC_WEIGHT = 1.5`, `SEARCH_FTS_WEIGHT = 0.4` (see Known Issues #33/#36)
6. Top 20 fused results, sorted — this is the final list, nothing further removes or reorders it
7. Each result gets an `excerpt` field: first ~220 chars of `content_text`, trimmed to word boundary with `…`
8. `content_text` and `embedding` are stripped from the response before sending to client

### 5. Search UI — Empty & Edge States

- **Empty state (has saves)**: On first load of the Search tab, shows 3 personalised chip suggestions fetched from `/suggestions`. Chips are cached in `sessionStorage` (`recall_suggestions`) for the session — static per session, not re-fetched on tab switch.
- **Empty state (no saves)**: If `/suggestions` returns `has_saves: false`, shows "Nothing saved yet. Save your first link →" with a CTA that switches to the Save tab.
- **Shimmer loading bar**: A single 4px-tall shimmer bar below the search input while loading — does not imply a result count.
- **Zero-results state**: Shows `"Nothing found for '[query]'"` with a "Save a page about this →" CTA that switches to the Save tab.
- **Recent searches**: Last 5 queries shown as dismissible rows when the search input is focused and empty. Tapping re-runs the search. Cleared on sign-out.
- **Session persistence**: Last query + results survive tab switching and page reload within the same browser session.

### 6. Personalised Search Suggestions

**Backend (`main.py` → `POST /suggestions`)**
1. Verifies JWT → `user_id`
2. Fetches `tag` + `url` for all of the user's saves
3. Tallies tag frequency and source frequency (using the same `get_source_label()` logic as the frontend)
4. Builds up to 3 chips using templates:
   - Top tag → `"my [tag] reads"`
   - 2nd tag → `"[tag] articles"`
   - Top source → `"things from [Source]"`
5. Falls back to generic phrases (`"what I've been reading"`, etc.) if the library lacks variety
6. Returns `{ chips: [...], has_saves: bool }` — frontend shows new-user nudge when `has_saves` is false

`get_source_label(url)` is a Python mirror of the frontend helper — kept in sync manually.

### 7. Android Share Sheet

**`manifest.json` config:**
```json
"share_target": {
  "action": "/",
  "method": "GET",
  "params": { "url": "url", "text": "text", "title": "title" }
}
```

**Frontend handling (`App.jsx` → `useEffect` on mount):**

Uses `extractSharedUrl(params)` — a robust helper that handles the fact that different apps encode the shared URL differently:
1. Checks `url` param first — if it starts with `http`, uses it directly (X/Twitter sends this)
2. Falls through to `text` then `title` params
3. If the param value starts with `http`, takes everything up to the first whitespace
4. Otherwise scans for an embedded URL anywhere in the string via regex (handles LinkedIn which prepends `"Article title\nhttps://..."` to the `text` param)

Once a URL is extracted:
- Stores it in `sessionStorage` as `pendingUrl` and switches to "save" view
- After auth resolves, auto-calls `handleSave(pending, true)` — the `true` is the `fromShareSheet` flag
- The `fromShareSheet` flag is passed as a **parameter**, not read from state, to avoid a stale closure bug (the `useEffect` closure captures the initial `handleSave` before any state updates take effect)

### 8. Clipboard Detection

On the Save tab (and on initial load if not a share-sheet trigger), `checkClipboard()` runs:
1. Calls `navigator.clipboard.readText()` — requires focus + user permission; silently ignores errors
2. If clipboard contains a valid URL, **pre-fills the URL input directly** (no banner — the input just appears with the URL ready to go)

### 9. Feedback — Chime + Haptic

`playSuccessChime()` uses the Web Audio API to synthesise a short rising-tone chime (880 Hz → 1320 Hz over 0.12 s, fading out over 0.45 s). Called on:
- Successful save
- Title edit confirmed
- Tag edit confirmed

`navigator.vibrate?.([50])` fires alongside each chime. The `?.` silently skips it on browsers/devices that don't support it.

### 10. Authentication

- Google OAuth via Supabase Auth
- `signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } })`
- After OAuth redirect, Supabase injects session tokens into the app
- `supabase.auth.getSession()` + `onAuthStateChange` listener keep `user` state in sync
- The `anon` key is safe to expose — RLS enforces per-user data isolation
- The backend uses the **service role key** (bypasses RLS) but manually enforces ownership via verified JWT `user_id`

### 11. Source Label + App Scheme Detection

`getSourceLabel(url)` maps URLs to human-readable names: X (Twitter), LinkedIn, Reddit, Notion, YouTube, Substack, or hostname-capitalised fallback.

`getAppScheme(url)` maps the same sources to native app deep link schemes used by the "Return to" button:
- X/Twitter → `twitter://timeline`
- Instagram → `instagram://feed`
- Reddit → `reddit://front`
- LinkedIn → `linkedin://feed`
- YouTube → `youtube://`
- Substack → `substack://`
- Notion → Android package `notion.id` (via the same Intent URL mechanism as the other 6 sources, not a `scheme://` — see Known Issue #13)
- Unknown → `null` (falls back to `window.history.back()`)

### 12. PWA Install Prompt (banner + bottom-of-page button)

A `useEffect` listens for `beforeinstallprompt` (Android/desktop Chrome only — never fires on iOS Safari) and `appinstalled`:
- `beforeinstallprompt` → `e.preventDefault()`, stores the event in `deferredInstallPrompt` state for later use (it's single-use).
- `appinstalled` → clears `deferredInstallPrompt`, sets `justInstalled` state, and writes `recall_installed = 'true'` to `localStorage` so the install UI never reappears in this browser.

`isStandalone` detects an already-installed/launched-from-home-screen session via `window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true` (the latter is iOS Safari's non-standard API).

Overall visibility gate: `showInstallUI = !isStandalone && !justInstalled && (deferredInstallPrompt || isIOS || isAndroid)`.

- **Banner** (`showInstallUI && !installBannerDismissed`) — renders below the header on every view. Primary button: if `deferredInstallPrompt` exists, calls `.prompt()` then awaits `.userChoice` and clears it; otherwise toggles `installStepsOpen` to reveal inline "Add to Home Screen" instructions (platform-specific copy via `installInstructions`, reusing `styles.overlaySteps`/`styles.overlayStep`). Dismiss (✕) sets `installBannerDismissed` and writes `recall_install_banner_dismissed = 'true'` to `localStorage`.
- **Bottom-of-page button** (`showInstallUI && installBannerDismissed`) — small fallback "Install ReCall" button rendered near `legalFooter`, shown on every view once the banner has been dismissed. Same click behavior as the banner's primary action. The banner and bottom button are mutually exclusive — exactly one is always visible while `showInstallUI` is true.

### 13. iOS Share Sheet (via Shortcuts app)

iOS/WebKit doesn't implement the Web Share Target API, so there's no way for a PWA to register as a native Share Sheet target without an App Store app + Share Extension. Even an installed/home-screened PWA never appears in the main Share Sheet app row — the only path on is a custom **Shortcut** with "Use with Share Sheet" enabled, which surfaces in the separate horizontally-scrolling **Shortcuts row** near the bottom of the share sheet (often behind "More").

On iOS (`isIOS`), the Settings panel has a "Save from any app" section (`shortcutGuideOpen` state):
- **Primary path** — if `SAVE_TO_RECALL_SHORTCUT_URL` (App.jsx:14, currently `null`) is set to an iCloud shortcut link, a 1-tap **"Add 'Save to ReCall' Shortcut"** button is shown, plus a note explaining the Shortcuts-row location. This installs a pre-configured shortcut — no manual steps.
- **Fallback / manual path** — a collapsible 6-step guide for building the **"Save to ReCall" Shortcut** by hand:
  1. Create a new shortcut, enable "Use with Share Sheet" (types: URLs, Safari Web Pages, Text)
  2. Add a "URL" action: `https://recall-iota-six.vercel.app/?text=` + Shortcut Input
  3. Add an "Open URLs" action using that URL
  4. Name it "Save to ReCall"

Once built (either path), sharing a link → Shortcuts row → "Save to ReCall" opens ReCall with `?text=<link>`, which the existing `extractSharedUrl`/`pendingUrl` flow (see #7) picks up. The install onboarding overlay's iOS branch points users to this Settings section.

**Important — use `?text=`, not `?url=`.** See Known Issue #21: the `url` query param has no regex fallback in `extractSharedUrl`, so it only works if the value is a bare `http...` string with nothing appended. The `text`/`title` params tolerate extra content (Safari Web Page / Text share types, embedded URLs) via a regex fallback. Any future share-target URL construction must use `?text=`.

**Maintaining the iCloud shortcut link** — if the "Save to ReCall" shortcut is ever rebuilt or renamed, regenerate its iCloud link (Shortcuts app → long-press → Share → Copy iCloud Link) and update `SAVE_TO_RECALL_SHORTCUT_URL` in App.jsx.

### 14. Import X Bookmarks

Three import paths, all funneling into the same source-agnostic `run_import_job` background pipeline (`main.py:458-496`) and `import_jobs` table (status/progress polling, `App.jsx` `pollImportStatus`):

1. **X OAuth (primary)** — one-tap "Connect X to import bookmarks" button (`App.jsx`, `connectXForImport`/`generatePKCE`) redirects to X's OAuth 2.0 PKCE consent screen (`scope=bookmark.read users.read`). On callback, the frontend POSTs `{code, code_verifier, redirect_uri}` to `POST /import/x-connect` (`main.py:576-662`), which exchanges the code server-side, calls `GET /2/users/{id}/bookmarks` (paginated, capped at `MAX_IMPORT_ITEMS`=500), and kicks off the import job. No X token is persisted — it's used once in-memory for that request and discarded, so reconnecting re-prompts consent each time. Requires `TWITTER_CLIENT_ID`/`TWITTER_CLIENT_SECRET` (backend) and `VITE_TWITTER_CLIENT_ID` (frontend).
2. **Bookmarklet (fallback)** — collapsed behind "Can't or won't connect your account?" in Settings. A draggable bookmarklet DOM-scrapes `x.com/i/bookmarks` (works around needing OAuth at all), passes collected tweet IDs via URL hash (`#import_tweets=...`, never sent over the network) to `POST /import/x-scraped` (`main.py:665-697`). Requires manual scrolling (no auto-pagination) and has Safari/Arc-specific drag workarounds. Kept because the OAuth path's reliability depends on the X dev app's billing/API-tier access being correctly configured — if that ever lapses, this still works for free.
3. **File upload (fallback)** — `handleImportFileChange` accepts an X bookmarks export file.

**Why both OAuth and a scraping fallback exist**: the OAuth flow was originally built first (`14c3420`), then immediately shelved (`f37b62a`) because X's legacy API tier gated bookmark reads behind a $200+/mo plan and the integration 403'd. The bookmarklet was added as the free workaround and became the primary CTA, leaving the OAuth code in the repo but unreferenced by any UI element. X's Feb 2026 move to pay-per-use pricing (~$0.005/read, no monthly minimum) removed that blocker, so OAuth was restored as primary — but the bookmarklet stays as a no-API-access-required fallback in case the dev account's billing/tier ever doesn't cover bookmark reads.

### 15. Reddit post + comment fetching

`fetch_reddit(url)` (`recall_core.py`) fetches a Reddit post — title, body, subreddit, image, **and top comments** — instead of falling into the generic article scrape, which previously got served Reddit's anti-bot "security check" interstitial and saved it as the title ("Reddit Verification Security Block"). It tries Reddit's official OAuth API first, and transparently falls back to an unauthenticated endpoint when no API credentials are configured:

1. The original URL is resolved (`follow_redirects=True`, no auth needed) to extract the canonical post ID — handles modern share shortlinks (`reddit.com/r/<sub>/s/<token>`, `redd.it/<id>`) that the Android Share Sheet produces. Shared by both paths below.
2. **If `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are set**: `_get_reddit_token()` exchanges them for an app-only `client_credentials` token (cached in-process, refreshed ~1 minute before its hourly expiry — unlike X's static `TWITTER_BEARER_TOKEN`, Reddit doesn't issue a long-lived token), then `GET oauth.reddit.com/comments/{id}` with that bearer token.
3. **Otherwise** (the current default — see Known Issue #30): `GET reddit.com/<path>.json` with a browser-like `User-Agent`, no auth. Both paths return the identical listing shape, parsed by the shared `_parse_reddit_listing()`.
4. Either way, the response is the post **and** the top-level comment tree in one call. Up to 5 real top-level comments (skipping `AutoModerator` and `[deleted]`/`[removed]` bodies) are folded into both `content_text` and the Gemini tagging context — comments are the actual value of most Reddit saves, unlike a tweet or LinkedIn post, so this is Reddit-specific and doesn't apply to any other source branch.
5. If both the post-ID resolution and the fetch fail for any reason (deleted/private post, blocked request), `process_save` falls through to `{"thin_content": True, ...}` exactly like a deleted tweet or LinkedIn authwall — never saves a row with a junk/blocked-page title.

Sparse image/link posts get a vision-analysis fallback the same way Instagram captions do (`analyze_image` on the post's preview image when `selftext` is short).

### 16. Newsletter saving via email forwarding

Newsletters arrive as email, not a URL — every other save path assumes a URL. `process_newsletter_email()` (`recall_core.py`) is a **sibling** to `process_save`, not a branch inside it, since the input is a parsed email rather than something to fetch. It converges on the same `extract_save_metadata_async`/`get_embedding`/upsert tail every other source uses.

1. **Ingestion**: a single shared CloudMailin inbound address (free tier, no custom domain) is shown to every user in Settings → "Save newsletters by email". Forwarding one issue manually saves it once; setting a Gmail filter to auto-forward a sender saves every future issue with zero ongoing effort.
2. **Webhook**: CloudMailin POSTs the parsed email (JSON Normalized format — `envelope`, `headers`, `plain`/`html`, `attachments`) to `POST /webhooks/email-inbound`. Authenticity is verified via HTTP Basic Auth embedded in the target URL configured in the CloudMailin dashboard (`EMAIL_WEBHOOK_SECRET`), not a signature header.
3. **Resolving which ReCall user this belongs to** (`_resolve_forwarding_sender`) — there's no per-user address (see Known Issue #32), so the sender must be matched to a signed-in account by email:
   - Checks `headers["x_forwarded_for"]` first. Gmail filter-based auto-forwarding adds this header as `<forwarding mailbox> <destination>` — the *first* address is the Gmail account that owns the filter, **not** the newsletter's original sender. This must be checked before falling back to `From`, or auto-forwarded mail tries to match the newsletter's own sender address and never resolves.
   - Falls back to the `From` header, which is correct for a manual forward (the user composed that outgoing message themselves).
   - Looked up against Supabase auth users via the admin API (`_find_user_id_by_email`) — there's no email→user_id table otherwise. No match → dropped and logged, not saved to the wrong account.
4. **Canonical URL**: the save's `url` is a Gmail deep link built from the email's `Message-ID` header — `https://mail.google.com/mail/u/0/#search/rfc822msgid:<message-id>` — which opens the exact original email in the inbox. Deliberately **not** a "view in browser" link scraped from the newsletter body: those are unreliable (can be a confusing intermediate page, or ambiguous when an email has several links) — the inbox copy is the one link that's always the real thing. Falls back to a synthetic `newsletter://<timestamp>` only if a message has no `Message-ID` at all (shouldn't happen in practice). `_html_to_text()` uses `beautifulsoup4` (not the stdlib `HTMLParser` used elsewhere — newsletter templates are too messy for it) to get clean text for search/tagging.
5. Webhook always returns 200 regardless of match/thin-content/duplicate outcome, so CloudMailin doesn't retry-loop a request that simply had nothing to save.

### 17. Notion page fetching

`fetch_notion(url)` (`recall_core.py`) reads genuinely public Notion pages (`notion.so`, `notion.site`, `app.notion.com` share links) via the existing `fetch_with_jina()` — it deliberately never calls `fetch_og_html()`/raw HTTP for Notion URLs: confirmed directly, a plain non-Jina fetch of an `app.notion.com/p/...` URL hits a redirect loop and fails outright on live test pages, so it would only ever waste a request.

1. **`jina_title` is always empty for Notion, not a wrong title** — `fetch_with_jina()` requests `X-Return-Format: text` from Jina, which omits the header lines (`Title:`, `URL Source:`) its own title-parsing logic looks for, so `jina_title` comes back `""` for every Notion fetch (confirmed directly; this is a general property of `fetch_with_jina()`, not Notion-specific). `fetch_notion()` discards it and passes a neutral `raw_title = "Notion"` into the shared `extract_save_metadata_async` tail instead — same pattern as Instagram's `author or "Instagram"` — letting Gemini derive the real title from body content.
2. **The actual bug**: when a page requires the viewer to be logged into a specific Notion account, Jina's fetched content is Notion's login-wall shell ("You're almost there! Sign in to see this page in \<Owner>'s Notion" + generic auth-provider button labels) — confirmed directly against the original bug report's URL. This text is long enough (400+ chars) to clear `QUALITY_THRESHOLD` and marketing-flavored enough ("What is Notion?" boilerplate) that Gemini confidently synthesized a plausible-but-entirely-wrong title from it ("Notion: AI workspace for teams · Notion") — the original bug. `NOTION_AUTHWALL_SIGNATURES` detects this shell and bails to `thin_content` before Gemini ever sees it, mirroring LinkedIn's `AUTHWALL_SIGNATURES` pattern (Known Issue #25), with a fallback title that honestly tells the user the page requires login rather than saving a confident-looking wrong one. This is a deliberate detect-and-degrade choice — bypassing the login wall itself is impossible without the viewer's own Notion credentials (see "Deferred Decisions").
3. **Genuinely public pages** do carry real content through Jina — confirmed directly, the real heading and body text came through in the fetched text alongside incidental UI boilerplate (a "who can comment" widget). A separate, narrower `NOTION_NOISE_PHRASES` list strips that boilerplate — kept distinct from `NOTION_AUTHWALL_SIGNATURES` so it can never cause a false-positive reject on an otherwise-real, fully public page.
4. One curly-quote gotcha confirmed directly: Notion's own copy uses a typographic apostrophe (`’`, U+2019) in "You're almost there," not a straight ASCII one — `fetch_notion()` normalizes both to `'` before signature matching so this doesn't silently fail to match.

---

## Supabase Schema

### Table: `saves`

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| user_id | uuid | FK to auth.users; used as RLS filter |
| url | text | original saved URL |
| title | text | AI-generated "Title · Author" |
| content_text | text | extracted page text (up to 5000 chars) |
| embedding | vector(768) | from gemini-embedding-001 |
| tag | text | Tech / Product / Business / Finance / Health / Personal / Other — still auto-generated by Gemini and stored, but **no longer displayed in the UI** (replaced by user-defined folders). Kept as substrate for the future Library/clustering feature. |
| topics | text | short, comma-separated topic/entity phrase extracted by Gemini at save time (e.g. `"crypto, venture capital, Paradigm fellowship"`), null for saves predating round 4. Used to compute `topic_embedding`; also useful for debugging search ranking. See Known Issue #36. |
| topic_embedding | vector(768) | embedding of the `topics` phrase (`RETRIEVAL_DOCUMENT`), compared against the query embedding at search time as a cleaner, more concentrated relevance signal than the full-content `embedding`. See Known Issue #36. |
| content_type | text | `article` (default) or `video` / `image` for media URLs |
| related_ids | uuid[] | IDs of semantically related saves (best-effort, may be null) |
| status | text | `'pending'` until background enrichment finishes, then `'ready'` (default `'ready'` — only the fast-path `/save` flow ever inserts a row as `'pending'`) |
| created_at | timestamptz | auto |

RLS is enabled — policies restrict all access to `user_id = auth.uid()`. This policy predates the migrations folder entirely and was never captured in version control until `sql/014_rls_hardening.sql` (Known Issue #39) explicitly reaffirmed it — the single most load-bearing control in the app, since both `match_saves` and the frontend's direct anon-key reads (Today's Saves list) depend on it. **`UNIQUE(user_id, url)`** (constraint `saves_user_id_url_key`, `sql/012_saves_unique_user_url.sql`) backs the duplicate-check collapse in Known Issue #38 — must be applied by hand in the Supabase SQL editor (after verifying no pre-existing duplicate rows) before deploying code that references it.

### Table: `folders`

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| user_id | uuid | FK to auth.users via RLS |
| name | text | unique per user (`UNIQUE(user_id, name)`) |
| created_at | timestamptz | auto |

RLS enabled — `user_id = auth.uid()` for all operations.

### Table: `save_folders`

| Column | Type | Notes |
|---|---|---|
| save_id | uuid | FK → `saves(id) ON DELETE CASCADE` |
| folder_id | uuid | FK → `folders(id) ON DELETE CASCADE` |
| created_at | timestamptz | auto |

Primary key is `(save_id, folder_id)`. Backend-only (service role) — the frontend never queries this table directly. RLS is now enabled with no permissive policy and the anon/authenticated `SELECT` grant is revoked (`sql/013_lock_down_save_folders.sql`, Known Issue #39) — before this fix, an anon/authenticated grant existed with RLS disabled, meaning anyone holding just the public anon key could read every user's save↔folder groupings via the raw PostgREST API. Cascade deletes mean: deleting a save removes its membership rows; deleting a folder removes its membership rows but leaves saves intact.

### Table: `push_subscriptions`

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| user_id | uuid | no FK — only the backend (service role) touches this table |
| endpoint | text | unique; the browser's push service URL (e.g. `fcm.googleapis.com/fcm/send/...` for Chrome) |
| p256dh, auth | text | the subscription's public key + auth secret, as returned by `PushManager.subscribe()` |
| created_at | timestamptz | auto |

One row per device/browser a user has enabled notifications on. Rows are deleted automatically by `send_save_ready_push()` when a push attempt comes back `404`/`410` (subscription expired/revoked). RLS is now enabled with no permissive policy and any anon/authenticated grant revoked (`sql/014_rls_hardening.sql`, Known Issue #39) — defense-in-depth, since the backend's service-role key bypasses RLS regardless and was already the only thing touching this table.

### RPC: `match_saves`

Postgres function using `pgvector` cosine similarity. Defined in `recall-backend/sql/010_match_saves_threshold.sql` (the original version predated version control — see Known Issue #33), extended by `sql/011_topic_embeddings.sql` (Known Issue #36). Parameters:
- `query_embedding vector(768)`
- `match_user_id uuid`
- `match_count int`
- `match_threshold float default 0.0` — rows with cosine similarity below this are excluded before `match_count` is applied. `/search` passes `SEARCH_MIN_SEMANTIC_SIMILARITY` (0.60, `recall_core.py`); `/ask` passes `ASK_MIN_RELEVANCE` (0.65, `main.py`). A caller that omits it gets the old unfiltered behavior (default `0.0`).
- `topic_query_embedding vector(768) default null` — added in round 4 (Known Issue #36). When provided, also returns `topic_similarity` (query vs. each row's `topic_embedding`). `/search`'s `do_search()` passes the same query embedding here as `query_embedding`; `/ask` omits it entirely and is unaffected (gets `topic_similarity = 0.0` for every row, which it doesn't use).

Explicitly returns `id, url, title, content_text, tag, content_type, status, created_at, similarity, topic_similarity` (`similarity = 1 - (embedding <=> query_embedding)`; `topic_similarity = 1 - (topic_embedding <=> topic_query_embedding)`, or `0.0` if either side is null). Filters to `user_id = match_user_id`, `content_type = 'article'`, `status = 'ready'`, and the `match_threshold` (on content `similarity` only — `topic_similarity` is not a recall-stage gate, see Known Issue #36 for why and its known limitation); orders by `embedding <=> query_embedding` ascending (closest first); limits to `match_count`.

### Remote MCP server (Claude/ChatGPT connector) — OAuth 2.1 tables

Backs `mcp_server.py`. See `recall-backend/sql/001_mcp_oauth.sql` (and follow-up
`002`–`004` fixes) for the exact DDL — no migration tool is used in this repo;
schema changes are run by hand in the Supabase SQL editor. All three tables below
(`mcp_oauth_clients`, `mcp_auth_codes`, `mcp_tokens`) now have RLS enabled with no
permissive policy and any anon/authenticated grant revoked (`sql/014_rls_hardening.sql`,
Known Issue #39) — defense-in-depth, since only the backend's service-role client
(via `mcp_server.py`) was ever meant to touch them.

#### Table: `mcp_oauth_clients`

| Column | Type | Notes |
|---|---|---|
| client_id | text | primary key |
| client_secret | text | plaintext, server-generated; null for public PKCE-only clients (see `002` migration for why this isn't a hash) |
| client_name | text | |
| redirect_uris | text[] | exact-match validated on every authorize/token-exchange call |
| grant_types | text[] | default `{authorization_code, refresh_token}` |
| token_endpoint_auth_method | text | default `client_secret_post`; Claude/ChatGPT register as `none` (public, PKCE-only) |
| registered_from_ip | text | abuse investigation only, not enforced |
| created_at | timestamptz | auto |

#### Table: `mcp_auth_codes`

| Column | Type | Notes |
|---|---|---|
| code | text | primary key |
| client_id | text | FK → `mcp_oauth_clients` |
| user_id | uuid | resource owner; no FK to `auth.users` (intentional — see below) |
| redirect_uri, redirect_uri_provided_explicitly | text, bool | |
| code_challenge, code_challenge_method | text | only `S256` accepted (enforced by the mcp SDK itself) |
| scope, resource | text | |
| expires_at | timestamptz | 5 min from creation |
| used | boolean | single-use, claimed atomically on exchange |

#### Table: `mcp_tokens`

| Column | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| access_token_hash, refresh_token_hash | text | sha256; only hashes stored — these are bearer credentials |
| client_id, user_id, scope | | |
| access_token_expires_at | timestamptz | 30 min |
| refresh_token_expires_at | timestamptz | 90 days |
| revoked | boolean | |
| rotated_from | uuid | self-FK; traces rotation lineage for theft detection |

`user_id` columns have no FK to `auth.users` by design — this schema is independent of which Supabase project owns user identity, and keeps the OAuth tables simple to reason about in isolation.

#### RPC: `mcp_exchange_refresh_token`

Atomically rotates a refresh token in one Postgres function call: locks the old row, revokes it, inserts the new pair linked via `rotated_from`, and returns the old row's `access_token_hash` (so the Python layer can evict it from its in-process cache immediately). If the old refresh token was already revoked — i.e. reused after a prior rotation — revokes the entire token family reachable via `rotated_from` and reports `theft_detected = true` instead of issuing new tokens.

---

## Deployment Setup

### Frontend — Vercel

- **Root directory**: `recall-frontend` (set in Vercel project settings — this is critical)
- **Build command**: `vite build`
- **Output directory**: `dist`
- **`vercel.json`** lives at the repo root (Vercel treats it as being inside `recall-frontend/`):
  ```json
  { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
  ```
  This is the SPA fallback needed for client-side routing and the share sheet redirect (`/?url=...`).
- **Environment variables** in Vercel dashboard:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_BACKEND_URL=https://recall-production-9941.up.railway.app`
  - `VITE_SENTRY_DSN`
  - `VITE_POSTHOG_KEY`

### Backend — Railway

- **Builder**: Nixpacks (auto-detects Python from `requirements.txt`)
- **Start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips=*` — the `--proxy-headers --forwarded-allow-ips=*` flags were added in Known Issue #39 so `get_remote_address()` (rate limiting) sees the real client IP behind Railway's proxy instead of collapsing every request into one bucket
- Configured via `railway.json` and `Procfile` (both specify the same start command); `railway.json` also sets `"healthcheckPath": "/"` (Known Issue #38)
- **Keep-warm**: `.github/workflows/keepalive.yml` (repo root) pings `GET /` every 10 minutes via GitHub Actions cron, so the backend shouldn't go cold between saves (Known Issue #38). Needs a commit at least every 60 days or GitHub auto-disables the scheduled workflow.
- **Environment variables** in Railway dashboard:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
  - `GEMINI_API_KEY`
  - `SENTRY_DSN`
  - `CORS_ORIGINS`
  - `AUTH_VERIFY_MODE` (see Known Issue #38 — leave at default `network` until canary logs confirm local verification matches)

---

## Branding

### Colors (App UI — always dark)

| Element | Value |
|---|---|
| App background | `#0f0f0f` |
| Card / input background | `#1a1a1a` |
| Border | `#333` |
| Body text | `#fff` |
| Muted text | `#888` / `#555` |
| Active button | white bg, black text |
| Inactive button | `#333` border, `#888` text |
| Success / green | `#4ade80` |
| Error / red | `#ef4444` |
| Duplicate / amber | `#fbbf24` |

### Colors (CSS Variables — light/dark system, currently only used in index.css)

| Token | Light | Dark |
|---|---|---|
| `--accent` | `#aa3bff` | `#c084fc` |
| `--bg` | `#fff` | `#16171d` |
| `--text-h` | `#08060d` | `#f3f4f6` |
| `--border` | `#e5e4e7` | `#2e303a` |

### Typography

- Font stack: `system-ui, 'Segoe UI', Roboto, sans-serif` — no custom web fonts loaded
- Monospace: `ui-monospace, Consolas, monospace`

### Logo — `favicon.svg` (48×46px)

A lightning bolt / cursor-shaped path:
- Base fill: `#863bff` (vivid purple)
- Layered over it: multiple Gaussian-blurred ellipses creating a glowing, frosted effect
- Colors used in glow layers: `#7e14ff` (deep purple), `#ede6ff` (pale purple), `#47bfff` (cyan highlight)
- Complex multi-filter SVG — do not hand-edit

### App Icon — `icon.svg` (80×80, used for both PWA home screen and browser tab favicon)

- Dark gray rounded-rect background (`#3a3a3a`, rx=17.6)
- White bracket glyphs `[ ]` drawn with lines (stroke-width 8, butt caps)
- White filled circle (r=8) as center dot at (40, 40)
- Simple, minimal — designed for home screen legibility at small sizes
- Used by both `manifest.json` (PWA icon) and `index.html` `<link rel="icon">` (browser tab)

---

## Known Issues & Things to Be Careful About

1. **Gemini SDK broken for embeddings** — always use direct HTTP POST to the REST API for `gemini-embedding-001`. The `google-genai` SDK is only used for `gemini-2.5-flash` text generation.

2. **`vercel.json` location** — must be at the repo root (Vercel sees it as `recall-frontend/` since root dir is set to that). Never create a `recall-frontend/vercel.json` — it doesn't exist and shouldn't.

3. **Service role key is backend-only** — `SUPABASE_SERVICE_KEY` bypasses all RLS. Never expose it to the frontend or commit it.

4. **All backend DB queries must filter by `user_id`** — RLS is enabled but the backend uses the service key which bypasses it. Always manually add `.eq("user_id", user_id)` to every query.

5. **Share Sheet race condition is handled** — the share URL arrives before auth loads. This is handled via `sessionStorage("pendingUrl")` consumed once auth resolves. Don't refactor the auth flow without preserving this.

6. **Clipboard API silently fails** — requires page focus and user permission. The `try/catch` around `checkClipboard()` is correct and intentional — don't remove it.

7. **(Superseded by #23)** Tweet fetching used to use oEmbed; it now goes through the official X API v2 (`_fetch_tweet_api`) with Jina/OG/syndication-API as enrichment/fallback layers — see #23.

8. **`vite-plugin-pwa` is NOT installed** — PWA install (manifest.json) is still manual, and there's still no offline support/caching. There **is** now a service worker (`recall-frontend/public/sw.js`, added for Web Push — see "Web Push notifications" #1c) — it only handles `push`/`notificationclick`, nothing else. Don't assume offline capability just because a service worker exists now.

9. **`App.css` is not used by the app** — it's leftover Vite boilerplate. All styles are inline in `App.jsx` via the `styles` object at the bottom of the file.

10. **React 19 + Vite 8** — cutting-edge versions; check plugin/library compatibility before adding new dependencies.

11. **Gemini model name** — the backend uses `"gemini-2.5-flash"`. Keep this consistent.

12. **`fromShareSheet` must be a parameter, not state** — `handleSave` is defined before the `useEffect` state updates resolve. Reading `viaShareSheet` state inside `handleSave` would always see the initial `false` value (stale closure). The flag is passed as `handleSave(pending, isViaShareSheet)` using the local variable from the useEffect scope.

13. **"Return to [App]" button uses Android Intent URLs** — Chrome standalone mode blocks both programmatic navigation (`window.location.href`) AND `<a href="custom-scheme://...">` to custom app schemes. The only reliable fix is Android Intent URL format: `intent://{host}{pathname}#Intent;scheme=https;package={app.package.id};end`. This goes through Android's intent system directly. The button must remain an `<a>` tag (not a `<button>` with `onClick`) and must NOT call `e.preventDefault()`. **`getAppScheme()` only knows package IDs for 6 sources** (X/Twitter, Instagram, Reddit, LinkedIn, YouTube, Substack) — for any other domain (e.g. a generic article site like fortune.com) it returns `null`, and the button falls back to `e.preventDefault(); window.history.back()`. That fallback is a no-op when the Share Sheet opened the PWA in a fresh browsing context (no prior entry in that tab's session history) — the common case. Because of this, the button is only rendered when it can actually do something: `getAppScheme(url)` is truthy, or `window.history.length > 1`. Don't remove that gating clause — without it, the button reappears for unknown sources and silently does nothing on tap.

14. **Share sheet URL extraction must handle embedded URLs** — different apps encode the shared URL differently. LinkedIn prepends the article title to the `text` param (e.g., `"Article title\nhttps://..."`). The `extractSharedUrl()` helper in the `useEffect` scans all three params (`url`, `text`, `title`) and uses a regex fallback to find the URL anywhere in the string. Don't simplify this back to a plain `startsWith("http")` check.

15. **Duplicate check happens before the full pipeline** — `/save` detects an existing row for the same `url + user_id` before fetching the page or calling Gemini (as of Known Issue #38, via an `INSERT ... ON CONFLICT DO NOTHING` against the `saves_user_id_url_key` unique constraint, not a separate pre-check `SELECT`). If found, returns `{ duplicate: True, ... }` immediately. The frontend shows an amber receipt and plays no chime. There is no re-save path.

16. **`handleSearch` uses `overrideQuery` parameter, not `query` state** — chip clicks (example chips, recent searches) call `handleSearch(chipText)` directly. Reading `query` state inside the function would see the pre-update value (stale closure). Always pass the intended query string as `overrideQuery` when calling from chip click handlers.

17. **`get_source_label()` exists in both frontend and backend** — the frontend `getSourceLabel(url)` (in `App.jsx`) and the backend `get_source_label(url)` (in `main.py`) must stay in sync. The backend version is used by `/suggestions` to tally source frequency. If new sources are added to one, add to the other.

18. **Search session persistence uses `sessionStorage`, not `localStorage`** — `recall_last_query` and `recall_last_results` survive tab switching and page reload but are cleared when the browser session ends. `recall_suggestions` is also session-scoped so chips refresh on next login. `recall_recent_searches` uses `localStorage` so it persists across sessions until sign-out.

19. **Filter dropdowns reset `displayCount`** — both the Source and Tag dropdowns call `setDisplayCount(5)` on change. This is intentional: switching filters should always start from the top of the filtered set, not mid-paginated.

20. **Install banner and bottom button are mutually exclusive, gated by `showInstallUI`** — `recall_install_banner_dismissed` (localStorage) switches the UI from the banner to the bottom button; `recall_installed` (localStorage, set on `appinstalled`) hides both permanently. `deferredInstallPrompt` is single-use — call `.prompt()` then clear it immediately after `.userChoice` resolves. Don't gate either UI element on `isStandalone` alone — also check `justInstalled`/`recall_installed`, since `appinstalled` can fire before the page re-evaluates `display-mode: standalone`.

21. **`extractSharedUrl`'s `url` param has no regex fallback — use `?text=` for any new share-target links.** Only `text`/`title` params get the `/https?:\/\/\S+/` regex fallback for embedded/extra-content URLs; `url` requires the value to already start with `http` or it returns `null` (share silently does nothing). The iOS Shortcut (#13) and the Android `share_target` manifest entry (#7) both rely on this — don't add a new integration that builds `?url=<value>` unless `<value>` is guaranteed to be a bare URL.

22. **`isIOS` also matches iPadOS Safari in desktop mode** — `isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)`. iPadOS Safari has sent a desktop ("Macintosh") User-Agent by default since iPadOS 13, so the UA regex alone misses iPads — without the `MacIntel` + `maxTouchPoints` check, iPad users fell through to `isDesktop`/Android-flavored copy (e.g. "Tap ⋮ in Chrome"), which is wrong for Safari and was the actual cause of a tester seeing Chrome-specific instructions. `isAndroid`/`isDesktop` derive from `isIOS`, so this fix propagates everywhere (install banner copy, onboarding overlay, Settings Shortcut guide).

23. **X API integration depends on the X dev app's billing/tier, which isn't verifiable from the repo** — `TWITTER_CLIENT_ID`/`SECRET`/`BEARER_TOKEN` only work if the X Developer Portal app is on pay-per-use (or another tier with read access) and bookmark/tweet-read scopes are actually enabled. If billing lapses or access is revoked, `/import/x-connect` 503s/400s (frontend falls back to the bookmarklet) and `_fetch_tweet_api` silently returns empty (single-tweet save degrades to the Jina/OG/syndication-API fallback chain) — both paths are designed to degrade gracefully rather than break saves/imports outright. Also: per X's Developer Policy, cached tweet content is expected to be removed if the source tweet is later deleted on X — ReCall doesn't currently enforce this (same as before the API migration; not new).

24. **Bookmark import OAuth doesn't persist X tokens** — `/import/x-connect` exchanges the code, uses the access token once in-memory to paginate bookmarks, then discards it. This is a one-tap import, not a background sync — reconnecting always re-prompts the X consent screen. Don't add token storage/refresh-rotation infra for this unless the feature changes to continuous sync.

25. **LinkedIn `safety/go` redirect resolution lives in `resolve_linkedin_redirect()`** (`recall_core.py`) — `lnkd.in` shortlinks return a 200 "this link isn't on LinkedIn" interstitial instead of an HTTP redirect, so the real destination has to be scraped out of the page's `external_url_click` anchor rather than trusted from the final response URL. Called from both `process_save_fast` and the top of `process_save` (harmless no-op the second time, since the URL is already resolved by then). If resolution genuinely fails (e.g. the target site is unreachable), it silently returns the *original* unresolved `linkedin.com/safety/go` wrapper rather than raising — `process_save` checks for this explicitly and bails to `thin_content` (see Known Issue #34) rather than proceeding to fetch/save the wrapper's own interstitial page as if it were the article.

26. **Never display a save title that later changes** — since `/save` returns a placeholder before the real title is known (see "Background save enrichment" #1b), the UI rule is: show either a shimmer placeholder or the final resolved title, never a plausible-but-wrong title that gets silently swapped. A title that visibly changes reads as a bug, not as progressive loading. Don't "optimize" the pending state by guessing a better placeholder title — keep it as a shimmer.

27. **`status` column gates what counts as a "real" save** — `saves.status` is `'pending'` until background enrichment finishes, then `'ready'`. Any new query against `saves` that aggregates/displays results to the user (search, suggestions, library filters, etc.) should filter to `status = 'ready'` (see `do_search`/`do_suggestions`) — otherwise a still-enriching row with a null tag/embedding can show up half-formed.

28. **Push notifications only fire for the interactive fast-path save, not bookmark import or MCP saves** — `send_save_ready_push()` is only called when `placeholder_id` is set in `process_save`. Calling it unconditionally would spam one push per item during a multi-hundred-item bookmark import. If a future use case wants import-completion notifications, that should be a single "import finished" push, not per-item.

29. **Windows blocks browser notifications at the OS level, independent of `Notification.permission`** — Windows Settings → System → Notifications has a per-app toggle for Chrome that, if off, silently drops every web push notification (no toast, nothing in Action Center either) even though `Notification.requestPermission()` reports "granted" and the backend's `webpush()` call succeeds with no error. When push notifications "don't work" during testing, check this before assuming the code is broken — DevTools → Application → Service Workers → "Push" test button simulates a push with no network involved and is the fastest way to isolate the two.

30. **Reddit's OAuth API is unauthenticated-adjacent and not a stable contract** — `fetch_reddit()` prefers Reddit's real `client_credentials` OAuth API over scraping when credentials are configured, which is far more reliable than the HTML page (which actively blocks bots with a "security check" interstitial — the original bug this fixed), but it's still not a paid/contracted API tier. Reddit could tighten or rate-limit `oauth.reddit.com` access in the future the same way X locked down its API and forced a pricing-model pivot (#23). If `REDDIT_CLIENT_ID`/`SECRET` are missing or every Reddit save starts silently returning `thin_content`, check this before assuming the code regressed.

31. **`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` are currently unset by design, not by oversight** — as of mid-2026, Reddit gates new API app registration behind a manual "Responsible Builder Policy" review (a support ticket, not an instant form); the legacy self-serve "create app" flow on `old.reddit.com/prefs/apps` accepts the captcha but silently rejects the submission with a policy notice instead of issuing credentials, and `developers.reddit.com` (Devvit) is a different product for apps that run *inside* Reddit, not a source of plain script-app credentials. Until/unless a manual application is approved, `fetch_reddit()` runs entirely on its unauthenticated `.json` fallback (see "Reddit post + comment fetching" above) — this is the expected, working state, not a degraded one to "fix" by chasing credentials again without a clear new path.

32. **Newsletter forwarding uses one shared inbound address, not a unique address per user** — a deliberate tradeoff to avoid buying/owning a custom domain (per-user addresses like `save+token@yourdomain.com` need MX records on a domain you control). Consequences: (a) a user must forward from the *same* email address they signed into ReCall with, or the webhook drops the email as unmatched; (b) Gmail auto-forward resolution relies on the `X-Forwarded-For` header (see "Newsletter saving via email forwarding" #16) — non-Gmail providers may not add this header on filter-based auto-forwards and will fall back to (and likely fail) the `From`-based match, so auto-forward-by-sender is effectively Gmail-only for now; (c) CloudMailin's free tier caps at 10,000 emails/month across the whole app, not per-user — fine at portfolio scale, would need a paid tier or per-user addressing to scale further.

33. **`SEARCH_MIN_SEMANTIC_SIMILARITY` / `SEARCH_SEMANTIC_WEIGHT` / `SEARCH_FTS_WEIGHT` (`recall_core.py`) and `ASK_MIN_RELEVANCE` (`main.py`) are empirically-tuned constants, not scientifically derived ones** — `match_saves` (see `recall-backend/sql/010_match_saves_threshold.sql`) now enforces a real cosine-similarity floor via its `match_threshold` parameter, fixing a bug where semantic search always returned its full quota of "least-bad" neighbors even when nothing in a user's library was actually relevant to the query (e.g. searching "usdt" surfaced an unrelated SEO tweet and a health article purely because they were the closest of a bad bunch). `/search`'s fusion score is now `SEARCH_SEMANTIC_WEIGHT * similarity + SEARCH_FTS_WEIGHT * (1 / (1 + fts_rank))` instead of pure rank-based RRF, so a confident semantic match can outrank a weak item that merely also contains the literal query term. All four numbers (0.35, 1.0, 0.4, 0.5) were chosen by reasoning about `gemini-embedding-001`'s typical similarity ranges, not measured against real query/result pairs. If real usage shows the threshold is too strict (relevant saves disappearing from search) or too loose (unrelated saves still slipping through), or the fusion weights let weak-keyword-only matches outrank strong semantic ones (or vice versa), retune these constants rather than assuming the underlying approach is wrong — see the "Verification"/tuning notes below. Don't raise `ASK_MIN_RELEVANCE` or `SEARCH_MIN_SEMANTIC_SIMILARITY` without checking both call sites — they're intentionally different values because `/ask` is precision-oriented (synthesizes a written, cited answer, so a false positive is worse) while `/search` is recall-oriented (a human scans a list, so it should stay more permissive). Also note: the full-text search branch in `do_search` has no `ts_rank`-based ordering available through PostgREST's `.filter(col, "fts", query)` builder — its "rank" is a `created_at desc` tiebreak, not true text-relevance order. This is a known limitation, not a bug to chase; a proper fix would mean adding a second dedicated RPC (mirroring `match_saves`) that computes `ts_rank`/`ts_rank_cd` explicitly. To tune the thresholds/weights against real data, temporarily add a `print(..., flush=True)` in `do_search` logging each semantic candidate's title + similarity, read it via Railway's log viewer against a few real queries, adjust, then remove the debug line.

**Update:** this threshold/fusion mechanism turned out to be necessary but not sufficient — see Known Issue #34. The 0.35/0.5 values above were calibrated against an embedding space later found to be overly compressed; both have since been re-derived (now 0.60/0.65, see #34) against the fixed embedding space. If search relevance issues resurface, check #34 first.

34. **Search relevance also needed a structural embedding fix, not just the threshold/fusion mechanism in #33** — live diagnostic testing (via the `recall_search` MCP tool, which shares `do_search()` with `/search`) against real queries ("usdt", "crypto") and topically-unrelated control queries ("cooking recipes", "javascript tutorial") showed the *same* degenerate saves scoring comparably (0.47–0.63 similarity) against all of them regardless of topic — proof of an embedding-space "hub" problem that no single threshold can fix, since genuine matches and noise occupied overlapping similarity ranges. Two compounding causes, both now fixed:
    - **`get_embedding()` (`recall_core.py`) now takes a `task_type` parameter** (`RETRIEVAL_DOCUMENT` default for saved content, `RETRIEVAL_QUERY` explicitly at both query-embedding call sites — `do_search()` and `/ask`). Gemini's embedding space is asymmetric between the two; using a single generic embedding for both, as the code did before, is a well-documented cause of compressed/low-discrimination similarity scores. Because this changes how vectors are computed, every existing save's `embedding` column needed re-computing for consistency — done via a one-off `recall-backend/scripts/reembed_saves.py` backfill (see "Folder Structure"). If a future change touches embedding generation again, re-run this backfill rather than assuming old and new vectors stay comparable.
    - **Two save-pipeline holes let content-free pages get indexed as if they were real content**, each acting as an embedding-space hub that surfaced for unrelated queries: (a) `resolve_linkedin_redirect()` silently returning an unresolved wrapper on failure (see Known Issue #25) — `process_save` now explicitly checks for `linkedin.com/safety/go` still being present after calling it and bails to `thin_content` instead of saving the wrapper's own interstitial page; (b) X's tweet-fetch path (`fetch_tweet()`) only screened Jina's fetched text against login-wall phrases (`X_JUNK_SIGNATURES`, renamed from `X_AUTHWALL_SIGNATURES`) — it had no equivalent check for X's own deleted/nonexistent-tweet 404 copy ("this page doesn't exist", "nothing to see here"), so a dead tweet link's 404 page got saved as if it were the tweet (the original "Page Not Found: Poodle Picture" bug report). Both phrase lists are now combined in one check.
    - Separately, `process_save()` (`recall_core.py`) now calls `validate_url()` directly rather than relying on callers to have already done it — the `recall_save` MCP tool (`mcp_server.py`) called `process_save()` with zero URL validation, unlike the REST `/save` route and bookmark-import path, which is how a non-URL test string (`"aba"`) ended up saved and indexed as another hub.
    - `expand_search_query()`'s Gemini call now runs at `temperature=0` (a dedicated `_SEARCH_EXPAND_CONFIG`, separate from the shared `_NO_THINKING` used elsewhere for tagging) — previously, identical searches could produce different query rewrites (and thus different results) run to run.
    - One-off `recall-backend/scripts/scan_junk_saves.py` reports (never auto-deletes) existing rows matching known junk patterns (non-`http` URL, `title == url`, an unresolved LinkedIn wrapper, or `X_JUNK_SIGNATURES`/LinkedIn-authwall phrases in `content_text`) for manual review. Run across the whole app (315 saves, 6 distinct users) it flagged 128 (40%) — almost all legacy X/LinkedIn saves from before the June 27 authwall fix, not fresh junk. Since most still had the real post/tweet text sitting alongside the boilerplate (titles came from a separate, cleaner `og:title`/API field), `recall-backend/scripts/reprocess_flagged_saves.py` was written to re-run the current save pipeline against each flagged row's original URL in place (`process_save(url, user_id, placeholder_id=existing_row_id)`) rather than deleting them — result: 1 non-URL test row deleted, 103 recovered with clean content, 21 correctly reclassified as genuinely-unrecoverable `thin_content` (with stale `content_text`/`embedding` explicitly cleared, since `_finalize_placeholder` alone doesn't touch them). Re-embedding junk text more precisely doesn't make it not-junk — reprocessing (recovering or correctly discarding), not just re-embedding, is what actually fixed these.
    - **`saves` is multi-tenant — a `recall_search`/`recall_save` MCP session is scoped to whichever Google account authorized that specific connector, not "the app's data" as a whole.** This mattered concretely during this fix: live MCP diagnostic queries only ever exercised the developer's own account, while the original bug report came from a different account entirely — `do_search(query, user_id)` had to be called directly (via a local script using the service-role client) against the *reporting* account's `user_id` to actually reproduce and verify the fix. Don't assume an MCP-connected session's results generalize to "the account with the bug" without checking `user_id` matches. The maintenance scripts above (`scan_junk_saves.py`, `reembed_saves.py`, `reprocess_flagged_saves.py`) deliberately operate across *all* users, not just one — appropriate for a schema/embedding-consistency fix, but worth knowing before reusing them for something account-specific.
    - `SEARCH_MIN_SEMANTIC_SIMILARITY` is now **0.60** (`recall_core.py`) and `ASK_MIN_RELEVANCE` is now **0.65** (`main.py`), re-derived empirically post-backfill by calling `do_search()` directly against the real reporting account for "usdt", "crypto", and unrelated control queries ("cooking recipes"). Even post-fix, this account's embedding space has a real, consistent "noise floor" around 0.53–0.58 for topically-generic saves (the corpus is heavily AI/startup/tech content, so almost anything in that space scores moderately against almost any tech-adjacent query) — 0.60 was the lowest value that cleanly separated genuine matches (which cleared 0.61+ on every test query, up to 1.0+ when an FTS keyword hit also applies) from that floor. This is still empirical, not derived — retune again the same way if real usage shows it's too strict (e.g. a query returns zero results despite an obviously relevant save existing) or too loose.

**Update:** the threshold retune fixed narrow/specific queries, but broad single-word queries (e.g. "crypto") still returned a long tail of generic-but-threshold-clearing results below the genuinely relevant ones — no similarity cutoff can cleanly separate "on-topic" from "generically adjacent" in a topically homogeneous corpus. See Known Issue #35.

35. **`filter_search_relevance()` (`recall_core.py`) adds an LLM judgment pass after the threshold/fusion mechanism in #33/#34, specifically for broad queries a similarity cutoff can't resolve on its own** — verified directly against the reporting account: for "crypto", the fused/thresholded candidate list had only the top 2 genuinely on-topic (a USDT/stablecoin article, a crypto VC fellowship post) but 9 more generic AI/startup/business saves clearing the 0.60 floor purely because this account's content is topically homogeneous. Raising the threshold further doesn't fix this cleanly (confirmed: it would also start dropping genuine matches on other queries) — the fix needed actual semantic judgment, not a bigger number.
    - **Mechanism**: after `do_search()`'s fusion sort, saves with a fused score **> 1.0** (i.e. cleared the semantic floor *and* also matched full-text search — a literal keyword hit on top of decent similarity) are auto-kept with no Gemini call at all; this is what guarantees a single obviously-correct result (e.g. "usdt") never depends on the LLM getting it right. Everything else is only sent to the judge call if there are at least `SEARCH_FILTER_MIN_CANDIDATES` (4) of them — a short list has nothing worth pruning and this avoids a wasted call on the common case.
    - **Prompt**: reuses the only existing "send Gemini a list, get indices back" pattern in the codebase (`/library`'s sub-topic clustering, `main.py`) — an indexed list of `title — first 300 chars of content_text` per candidate, asked to return `{"keep": [indices]}` as bare JSON. Judged against the **original, unexpanded** query text (not `expand_search_query()`'s broadened form) since the expansion exists to widen recall for embedding, and feeding its broadened concept into a precision filter would validate results against something the user never typed.
    - **Thinking is deliberately left ENABLED for this one call** (`_SEARCH_FILTER_CONFIG`, `thinking_budget=1024`) — every other Gemini call in this file disables thinking for speed, but measured directly: with thinking disabled, the model missed that "Paradigm" (a bare company name with no other context) is a crypto VC fund, and kept a candidate that was empirically nothing but bare unexpanded links with zero descriptive text. Smaller thinking budgets (64–512) were faster but reverted to the same shallow, entity-blind judgments — only 1024 reliably used named-entity knowledge and correctly treated evidence-free candidates as unknowable rather than guessing. This is a deliberate ~5-10s-per-call latency-for-accuracy tradeoff, not an oversight — `SEARCH_FILTER_TIMEOUT` is set to 15s to give it comfortable headroom.
    - **Fails open unconditionally**: any Gemini API error, timeout, or unparseable response, *or* an empty `{"keep": []}` verdict (treated as an untrustworthy misfire rather than a genuine "nothing is relevant" judgment, since `match_saves` already enforces a similarity floor before anything reaches this code) — all fall back to returning the pre-filter fused list completely unchanged. This stage can only ever remove candidates or leave the list as-is; it never adds, and never reorders (survivors keep their original fusion-score order).
    - **Frontend**: `/search` had no progressive-loading UX before this, unlike `/ask`'s existing `askStep` timer ladder (`App.jsx`) — since the filter can add several real seconds, `App.jsx` now has an equivalent `searchStep` state/effect (`"Searching your saves…"` → `"Checking relevance…"` at 1400ms) rendered under the same shimmer bar, gated on `loading && !askLoading` so it doesn't fire during folder/source browsing (`browseByFilter`, which reuses the same `loading` flag but never touches this backend filter).
    - Only `/search`/`recall_search` (MCP) go through this — `/ask` has its own precision-oriented `ASK_MIN_RELEVANCE` threshold and is untouched by this change.

**Update:** this fixed precision, but the LLM call (thinking-enabled, per-search) cost 5-15s whenever it engaged — the user then asked whether search could be both fast (Google-speed, over a corpus orders of magnitude smaller than the web) and precise. `filter_search_relevance()`, `expand_search_query()`, and this issue's `searchStep` frontend addition were all removed and replaced by a precomputed-embedding architecture — see Known Issue #36.

36. **Query-time relevance judgment was moved to save time — no generative LLM call anywhere in `/search`'s request path** — prompted directly by the user asking why search should be slower here than Google's, given the corpus (a few hundred saves per user) is minuscule compared to web-scale search. The diagnosis: round 3's `filter_search_relevance()` (#35) and `expand_search_query()` (#33) both did expensive LLM reasoning *at query time*, while the app's own background-enrichment architecture (#1b) already proves save-time latency is invisible to the user. Google's own speed comes from precomputing everything expensive (crawling, PageRank) so query time is pure arithmetic — this round applies the same idea.
    - **Save time** (`recall_core.py` → `extract_topics()`/`extract_topics_async()`, called from `process_save`'s common article tail and `process_newsletter_email`, alongside the existing `extract_save_metadata_async()`): a dedicated Gemini call distills each save down to a short, comma-separated topic/entity phrase (e.g. `"crypto, venture capital, Paradigm fellowship"`), then that phrase is embedded separately (`get_embedding(topics, task_type="RETRIEVAL_DOCUMENT")`) and stored in a new `topic_embedding` column (plus the raw phrase in `topics`, useful for debugging/future features). **Thinking is kept enabled** (`_TOPIC_EXTRACTION_CONFIG`, `thinking_budget=1024`, repurposed from #35's `_SEARCH_FILTER_CONFIG`) — the same named-entity world-knowledge that required thinking in #35's query-time filter (recognizing "Paradigm" as a crypto VC) is needed here too, but now it's spent once per save, asynchronously, at a point in the pipeline where extra latency is free.
    - **Query time** (`do_search()`): embeds the raw query once and passes it as *both* `query_embedding` and `topic_query_embedding` to `match_saves` (extended with a 5th, default-`null` parameter — see `sql/011_topic_embeddings.sql` and the RPC section below), which returns both a `similarity` (query vs. full content) and `topic_similarity` (query vs. the topic phrase) column in one round trip. No expansion call, no relevance-filter call — one embedding API request plus Postgres queries, full stop.
    - **A topic-similarity floor was required, not just a fusion weight** — the first implementation only added `topic_similarity` into the fusion score (`SEARCH_TOPIC_WEIGHT`); verified directly against the reporting account, "crypto" still returned all 16 threshold-clearing candidates, barely reordered, because additive weighting alone re-ranks but never removes anything, and the query-time filter it replaced was the only mechanism that had ever actually cut the tail. Diagnostic printing of the raw components showed *why* a floor works: topic_similarity showed a real, consistent gap for "crypto" (genuine matches at 0.598–0.605, generic-adjacent noise at 0.533–0.578) — a cleaner separation than raw content similarity ever had (the same "hub" problem from #34, just less severe on short concentrated phrases than on full diluted article text). `SEARCH_TOPIC_MIN_SIMILARITY = 0.58` (`recall_core.py`, applied in Python in `do_search()` rather than in `match_saves`' SQL, since it's still being empirically tuned and a Python constant is faster to retune than another migration) drops any semantic candidate whose topic_similarity is a genuine nonzero low score; a topic_similarity of exactly `0.0` means "no topic_embedding yet" (missing data) and is never gated, only a confirmed-low score is.
    - **Verified against the real reporting account** (`0fe749da-3342-40cd-8d2a-38f6f1ab39a9` — see #34 on why this must be checked directly, not via an MCP session scoped to the developer's own account): "crypto" 16→3 (USDT article, Paradigm fellowship, Kalshi/Polymarket — identical set to #35's LLM-filter result), "usdt" still exactly 1 result, "startup" correctly dropped AI-tool-specific saves (Claude+SEO, AI Second Brain) that don't belong under "startup" specifically, "AI" correctly dropped non-AI political/philosophy saves (Zelenskyy, BJP politics, "Pitfalls of Pure Logic") while keeping genuine AI content. **Latency**: ~1.4-1.5s steady-state (a cold first call in a fresh process runs ~2.5-3.5s, one-time connection warm-up), down from #35's 6-17s — no generative LLM call in the path at all now.
    - **Known pre-existing gap, not introduced by this round**: "y combinator" still returns 0 results, because `match_saves`' recall stage (`match_threshold` on *content* similarity, 0.60) excludes a save whose content-similarity to that exact phrase falls short — even though that save's `topics` column explicitly contains "Y Combinator (startup accelerator, venture capital firm)". `topic_similarity` in the current design only reorders/filters candidates *already recalled* by content similarity; it doesn't yet expand recall. Fixing this would mean using `topic_similarity` for recall too (e.g. an `OR` condition in `match_saves`), which is a larger change than this round's scope — noted here for a future pass, not treated as a regression.
    - **Backfill**: `recall-backend/scripts/backfill_topics.py` — cheaper than earlier backfills (`reembed_saves.py`, `reprocess_flagged_saves.py`) since `content_text` is already stored for every `ready` row, no URL re-fetching needed. Run once across all 315 article saves / 6 users; 3 rows logged as "FAILED" but were confirmed to have written successfully regardless — the failure was `print()` choking on a non-ASCII character in the Windows console encoding (the same cosmetic issue noted in #34's `reprocess_flagged_saves.py` run), not a real data-loss failure.
    - `SEARCH_TOPIC_WEIGHT` (1.5) and `SEARCH_TOPIC_MIN_SIMILARITY` (0.58) are empirically tuned the same way every other search constant in this file has been (#33/#34) — retune the same way (direct `do_search()` calls against a real account, inspect raw `similarity`/`topic_similarity` components) if real usage shows either value is too strict or too loose.
    - **Frontend**: round 3's `searchStep` progress-ladder addition (`App.jsx`) was reverted — its entire premise (a multi-second wait needing reassurance text) no longer holds at ~1.4s, so `/search` is back to just the plain shimmer bar. `/ask`'s own `askStep` ladder is untouched.
    - `/ask` (`main.py`) is deliberately untouched by this round, same scoping precedent as #35 — it calls `match_saves` without the new `topic_query_embedding` parameter, so it gets `topic_similarity = 0.0` for every row and its behavior is unchanged.

37. **A stale-closure race silently routed every share-sheet save through the guest preview flow, even for signed-in users** — reported symptom: sharing a link via Android's Share Sheet showed the "Your link is ready. Save it to start building your library." guest message, randomly flipped the active tab to Search, showed no new row in Today's Saves, and required a manual re-save that then lacked the "← Return to [App]" button. Root cause: the share-sheet flow consumes its `pendingUrl` from inside the mount-time `useEffect(() => {...}, [])` (`App.jsx`), calling `handleSave(pending, isViaShareSheet)` in the *same synchronous callback* as `supabase.auth.getSession().then(({ session }) => { setUser(session?.user ?? null); ...; handleSave(...) })`. `setUser(...)` schedules a re-render but — since React never flushes a re-render synchronously mid-callback — `handleSave` still reads that render's closed-over `user` value, not the one just set. At mount that's `null` (from `useState(null)`), so `handleSave`'s `if (!user)` branch (added by commit `b13fa6e`, "Add real pre-signup save preview") always evaluated true for a share-sheet save, regardless of real auth state, diverting it into `saveBeforeSignup()` — the preview-only `/save/preview` endpoint (no real row written), which nulls `saveReceipt` (losing `fromShareSheet`, hiding the Return button) and, on its own preview fetch failing/being thin-content, flips `view` to `"search"`. No real `/save` call ever ran, so `fetchTodaySaves()` (only invoked from the real-save branch) never refreshed the list. **This was empirically confirmed, not just reasoned about**: an initial fix attempt (redirecting the call sites through a `handleSaveRef`, mirroring the existing `finalizeSaveRef` pattern from "Background save enrichment" #1b) was tested via a headless-Chrome CDP harness with a seeded fake Supabase session, and console instrumentation showed the ref still resolved to the stale, pre-`setUser` closure at call time — the redirection alone didn't fix anything, because the underlying problem is *when* `user` is read, not *which* `handleSave` identifier is called. **Actual fix**: a `userRef` (`useRef(null)`) is now written synchronously at every place `setUser(...)` is called (both sign-in paths and both sign-out paths), and `handleSave` checks `userRef.current` instead of the `user` state variable — since `userRef` is a single stable object shared by every render's closure, reading `.current` always gets the value as of that exact moment, independent of React's render/commit timing. Re-verified with the same CDP harness: a signed-in-session share now correctly takes the real-save branch; a genuinely guest (no session) share is unaffected (still never auto-invokes `handleSave` at all, same as before — `pendingUrl` just waits in `sessionStorage` for a subsequent real sign-in). **Known remaining gap, not fixed by this round**: a *genuinely* signed-out user who shares a link, gets routed into the guest preview, then signs in, still has to press Save manually afterward (via the `recall_pre_auth_url` restore flow) — which loses `fromShareSheet`/the Return button the same way. Fixing that would mean threading `fromShareSheet` through `saveBeforeSignup` → `preSignupSave` → the post-signin restore → an auto-triggered save, which is more scope than this regression fix; flagged here for a future pass if it comes up again.

38. **Save-flow latency (share-sheet tap → "done" acknowledgement) — same "latency is a relevance signal" thesis as search (#33-#36), applied to saves.** The user's framing: tapping ReCall in Android's share sheet (or pasting a link) should show a "done, you can go back" state — the "Saved ✓" + "← Return to [Source]" receipt — within 5 seconds, reliably. Two research passes plus direct verification (JWKS endpoint curl, venv dependency check, exact line-numbered reads) found this was not a UI-gating problem — the Return-to-source link was already correctly rendering as soon as the `pending` placeholder response came back, not waiting on background enrichment — but a real network-round-trip and cold-start problem, both on the client and the backend:
    - **`get_user_id()` (`recall_core.py`) was a blocking network round-trip to Supabase's GoTrue `/auth/v1/user` endpoint, not local JWT verification** — confirmed by tracing into `supabase_auth`, and confirmed to back all ~28 authenticated call sites in `main.py`, not just `/save`. **Fixed**: local verification via `PyJWKClient` against `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Empirically confirmed (not assumed) that this Supabase project signs access tokens with an asymmetric **ES256** key, not the legacy HS256 shared-secret scheme — `curl {SUPABASE_URL}/auth/v1/.well-known/jwks.json` returns a non-empty `keys` array with `"alg":"ES256"`, so there's no `SUPABASE_JWT_SECRET` to manage. PyJWT was already present transitively (via `supabase_auth`) in `recall-backend/venv`, confirmed via `python -c "import jwt; print(jwt.__version__)"` → `2.12.1` — zero new-install risk, now pinned directly in `requirements.txt`. Gated by `AUTH_VERIFY_MODE` (env var, default `"network"`): in network mode, `get_user_id()` still calls the old GoTrue endpoint for the real answer but **also** locally verifies the same token and logs `[auth_canary] MISMATCH ...` if the two ever disagree — this must run clean against real traffic before flipping the env var to `"local"` (which skips the network call entirely). **Accepted tradeoff**: local verification can't see an admin-side ban/account-delete until the token's ~1hr natural expiry; acceptable since the backend's service-role key was already doing identity-scoping, not RLS enforcement, so this bounds to "a stale identity can write a few more rows for up to ~1hr post-deletion," not a cross-user escalation.
    - **`process_save_fast()`'s duplicate-check `SELECT` + placeholder `INSERT` were two sequential blocking Postgres round-trips on every single save.** **Fixed**: collapsed into one `INSERT ... ON CONFLICT (user_id, url) DO NOTHING` (via supabase-py's `.upsert(..., on_conflict="user_id,url", ignore_duplicates=True)`), backed by a new `UNIQUE(user_id, url)` constraint (`sql/012_saves_unique_user_url.sql`, constraint name `saves_user_id_url_key`) — no such constraint existed before this (duplicate detection was purely application-level). An empty `result.data` means the row already existed (conflict) — only then does a follow-up `SELECT` fetch its details for the `{ duplicate: True, ... }` response (`_duplicate_response()` helper, `recall_core.py`, shared by every call site below). **Cost after**: 1 round-trip for new URLs (the common case), 2 only for actual duplicates (no worse than before). **Hard sequencing**: this migration must be applied by hand in the Supabase SQL editor (per this repo's established no-migration-tool convention) *before* deploying code referencing `on_conflict="user_id,url"` — the migration file's own STEP 0 is a read-only query to check for pre-existing duplicate rows that would make the `ALTER TABLE` fail; run it first. **Companion fix, same deploy**: `process_save()`'s two direct-insert branches (media-save and article-save, reached only when `placeholder_id` is unset — i.e. only by the MCP `recall_save` tool and bookmark import, which intentionally skip `process_save_fast`) and `process_newsletter_email()`'s insert each already had their own pre-check `SELECT`, but a concurrent save of the same URL can still land in the gap between that check and the eventual insert (which, for the article path, is *after* a full fetch + Gemini pipeline — a wide window). Once the constraint exists, that race now surfaces as a Postgres `23505` unique-violation (`postgrest.APIError`, `.code == "23505"`) instead of silently creating a duplicate row — all three sites now catch that specific code and degrade to the same `_duplicate_response()` shape rather than 500ing.
    - **No Railway keep-warm existed** (`railway.json` was bare — build/deploy only) — a cold start could singlehandedly blow the whole latency budget regardless of every other fix. **Fixed**: `.github/workflows/keepalive.yml` (repo root) pings the existing `GET /` health check (confirmed to do zero Supabase/Gemini work) every 10 minutes via GitHub Actions cron; `railway.json` also now sets `"healthcheckPath": "/"` so Railway's own deploy-time health checks exercise the same cheap route. Chosen over an external monitoring service (e.g. UptimeRobot) to avoid a third-party account, at the cost of GitHub Actions' own timing slop (can slip a few minutes under GH load) and auto-disabling scheduled workflows after 60 days of repo inactivity — a commit within that window keeps it firing.
    - **Frontend: `handleSave` (`App.jsx`) called `await getToken()` before it could even fire the `/save` POST, and `getToken()` re-called `supabase.auth.getSession()` every time** — a second, redundant session lookup, even though the mount-time share-sheet effect had already resolved the session moments earlier; nothing cached the token. **Fixed**: extended the existing `userRef` pattern (Known Issue #37) with a parallel `tokenRef` (`useRef(null)`), written everywhere `userRef.current` is written (mount `getSession()`, `onAuthStateChange`, `signOut`, `deleteAccount`). `getToken()` now reads `tokenRef.current` first, only falling back to a real `getSession()` call on cache miss; a `401` response from `/save` clears `tokenRef.current` so a stale cached token can't poison every subsequent attempt in the session.
    - **The `/save` POST's `AbortController` timeout was 45000ms** — a genuinely stuck request left the user on an indefinite optimistic shimmer for up to 45s before any error appeared, which doesn't match a 5s UX goal even as a failure mode. **Tightened to 8000ms** — not 1-2s, since this is a stuck-request safety net rather than the 5s target itself; 8s gives ~3-6x headroom over the expected ~0.5-1.5s fast-path latency post-fixes above, while failing far faster than the old 45s if something is genuinely wrong.
    - **Out of scope, and why**: service-worker app-shell precaching (`public/sw.js` still has zero caching — only `push`/`notificationclick` handlers) targets JS-bootstrap time, not the server round-trip this round addressed, and is already separately tracked under "Not Yet Built"; switching the whole Supabase client to its async variant would help concurrency/throughput under load, not this single request's floor latency, and would touch ~28+ call sites for a benefit orthogonal to this goal; no retry logic was added to `/save` since the ask was to fail fast, not retry.
    - **Estimated result** (not yet measured against live production traffic): roughly 150ms-1s for a warm backend, down from 3 blocking network round-trips plus a possible multi-second cold start — comfortably inside the 5s goal. Verification/rollout still open: canary-compare `AUTH_VERIFY_MODE=network`'s logged mismatches before flipping to `local`; confirm via Sentry/Railway logs that non-duplicate saves now show 1 Supabase call instead of 2; watch Railway's cold-start frequency before/after the keep-warm workflow goes live.

39. **Pre-launch security audit ahead of opening ReCall to an external beta cohort** — a full pass looking specifically for issues an anonymous/malicious external user could exploit, as opposed to prior rounds which were mostly correctness/relevance-focused. Found and fixed five distinct issues:
    - **SSRF via IPv4-mapped IPv6 literals** — `is_safe_url()` (`recall_core.py`) checked every resolved IP against `_PRIVATE_RANGES`, but an address like `::ffff:169.254.169.254` (the cloud metadata IP, IPv4-mapped into IPv6 form) is a distinct `ipaddress` type from any entry in those ranges, so `ip in net` silently returned `False` for every range — the check never fired for this address family. Fixed by unwrapping `IPv6Address.ipv4_mapped` before the range check.
    - **SSRF via unvalidated redirect chains** — every fetch of a user-influenced URL used `httpx`'s `follow_redirects=True`, which validates only the *initial* hostname and then blindly trusts every subsequent redirect hop — a public domain that 302s to an internal/metadata address would sail through untouched. New `safe_get()` helper (`recall_core.py`) re-validates each hop against `is_safe_url()` before following it (`follow_redirects=False` + manual loop, capped at 5 hops), and now replaces `follow_redirects=True` at all 12 call sites that fetch a user-influenced URL (`analyze_image`, `fetch_instagram`, `fetch_youtube`, `fetch_reddit`, `_fetch_tweet_card_title`, `fetch_with_jina`, `fetch_og_html`, `resolve_linkedin_redirect`, both t.co-resolution fallbacks in `process_save_preview`/`process_save`). `resolve_linkedin_redirect()` specifically was firing its request *before* validating the attacker-controlled `target` query param at all (a bare try/except only checked the *result*) — now validates first, and returns the original unresolved URL if the target is unsafe (same "bail to thin_content" path as an unresolvable redirect, see Known Issue #25).
    - **Zip-bomb DoS in bookmark import** — `extract_tweet_ids()` (`main.py`) read zip members via `zf.read(name)`, which trusts the member's uncompressed-size metadata and only discovers the true size after fully decompressing into memory — a small crafted zip can expand to gigabytes and OOM the single-worker process for every user, not just the uploader. New `_read_zip_member_bounded()` reads in 1MB chunks against a `MAX_IMPORT_DECOMPRESSED_BYTES` (100MB) total budget, raising before the budget is exceeded rather than after.
    - **~20 mutating/expensive routes had no rate limiting at all** (folders CRUD, push subscribe/unsubscribe, account deletion, wiki, import status, MCP connection management) — now covered by `@limiter.limit(...)` like `/save`/`/search` already were. Separately, the mounted MCP OAuth sub-app (`/register`, `/token`, `/authorize`, `/revoke` — see "Remote MCP server" above) is unreachable by slowapi's route decorators entirely, since it's a separately-mounted ASGI app, not a route on this FastAPI app — `/register` in particular is unauthenticated Dynamic Client Registration and was open with zero throttling. Fixed with a hand-rolled `mcp_oauth_rate_limit_middleware` (`main.py`, `@app.middleware("http")`, using `cachetools.TTLCache` for a coarse IP-keyed fixed-window count per path) — Starlette's HTTP middleware wraps the entire ASGI app including mounted sub-apps, so this catches those paths regardless of mount order. `Procfile`/`railway.json` now also pass `--proxy-headers` to uvicorn so rate-limit keys use the real client IP behind Railway's proxy instead of collapsing every request into one bucket.
    - **RLS gaps across four tables** — `save_folders` had an anon/authenticated `SELECT` grant (from `008_grant_save_folders.sql`) with RLS disabled entirely, meaning anyone holding just the public anon key could read every user's save↔folder groupings via the raw PostgREST API with zero authentication (`sql/013_lock_down_save_folders.sql` revokes the grant and enables RLS). `push_subscriptions` and the three MCP OAuth tables (`mcp_oauth_clients`, `mcp_auth_codes`, `mcp_tokens`) had no documented grant in any migration, but weren't confirmed locked down either — `sql/014_rls_hardening.sql` is an idempotent hardening pass enabling RLS + revoking any stray anon/authenticated grant on all four, safe to re-run even if already correctly configured. That same migration also explicitly reaffirms `saves`' owner-only RLS policy (`user_id = auth.uid()`) in version control for the first time — it predates this repo's migrations folder entirely and had never been captured, despite being the single most load-bearing control in the app (both `match_saves` and the frontend's direct anon-key reads depend on it). Since the real production policy's actual name was unknown, the migration's `DROP POLICY IF EXISTS "saves: owner only"` may not clean up whatever the live policy is actually called — harmless (permissive policies OR together, so nothing becomes over-permissive), just means Supabase may end up with two identically-scoped policies rather than one.
    - **MCP consent screen didn't show which app you were actually authorizing** — Dynamic Client Registration lets anyone self-register an OAuth client named `"Claude"` or similar with an attacker-controlled `redirect_uri`; the consent screen (`App.jsx`, `approveMcpConsent`'s render branch) only ever showed the self-reported `client_name`, never verified. Now also displays the actual `redirect_uri` host, the one signal a user has to catch an impersonating app before approving.
    - **Verified directly** (not just reasoned about): crafted SSRF payloads (metadata-IP literal, IPv4-mapped IPv6, a malicious redirect chain) confirmed blocked with zero network calls; legitimate fetches (YouTube oEmbed, plain article fetch) confirmed still working; a crafted zip-bomb confirmed rejected cleanly; newly rate-limited routes (including `/register` on the mounted sub-app) confirmed returning `429` past their threshold.

40. **Notion page fetching relies entirely on Jina Reader; a raw/OG fetch of a Notion URL is dead weight, not a fallback** — confirmed directly against live `app.notion.com` URLs: a plain HTTP GET immediately hits a redirect loop and fails outright (`safe_get`'s `max_redirects` exceeded), so `fetch_og_html()`/raw `<title>`/OG-tag scraping is never called for Notion (see `fetch_notion()`, "Notion page fetching" #17). Separately, `jina_title` is *always empty* for Notion (not a wrong-but-present title) because `fetch_with_jina()` requests Jina's plain-text format, which omits the header line its title-parsing logic looks for — this is a general property of `fetch_with_jina()`, confirmed directly, not something specific to Notion. The actual failure mode is content-level: a login-walled page's fetched text is Notion's own login-wall shell, long and marketing-flavored enough to clear `QUALITY_THRESHOLD` and fool Gemini into synthesizing a confident-but-wrong title from it (the original bug report: a save titled "Notion: AI workspace for teams · Notion"). `NOTION_AUTHWALL_SIGNATURES` (`recall_core.py`) detects this shell and bails to `thin_content`; it's deliberately a *narrower* list than `NOTION_NOISE_PHRASES` (also `recall_core.py`), which strips a "sign up to comment" widget that can legitimately appear on an otherwise-real, fully public page — conflating the two lists would reject good saves. The apostrophe in Notion's "You're almost there" copy is a typographic `’` (U+2019), not a straight `'` — confirmed directly by inspecting the raw fetched bytes; `fetch_notion()` normalizes both before matching. If Notion saves start silently returning `thin_content` for pages you believe are genuinely public, check this signature list first (Notion may have changed its login-wall copy) before assuming the pipeline regressed.

---

## Current Status

### Working
- Google OAuth sign-in / sign-out
- Saving URLs: web pages, X/Twitter tweets, Instagram posts, LinkedIn articles, Notion pages
- AI-generated title with author attribution (`"Title · Author"`)
- Inline title editing from the save receipt card
- **User-defined folders** — opt-in curation; saves can belong to 0 or many folders. "+ Folder" button on receipt card, Today's list cards, and search result cards opens a bottom-sheet picker. Folder management (rename/delete) in Settings → Folders accordion. Tag auto-generation still runs silently (stored in DB, not shown in UI).
- Auto-categorization into 7 tags (stored silently; not shown in UI — see folders above)
- Duplicate URL detection — shows "Already in ReCall" with original save date, no re-save
- Optimistic UI — shimmer receipt appears instantly on save tap
- **Background save enrichment** — `/save` returns a confirmed pending placeholder in well under a second; the real title/tag/embedding land moments later via Supabase Realtime (with a polling fallback), resolved in place rather than ever swapping a visible title
- **Save-flow latency reduction** (Known Issue #38) — local JWT verification (kill-switch gated, `AUTH_VERIFY_MODE`), collapsed duplicate-check+insert into one round-trip, GitHub Actions keep-warm ping, frontend token caching, tightened abort timeout — targets a 5s share-sheet-tap-to-acknowledgement budget
- **Web Push notifications** — opt-in (Settings → "Notify me when saves finish"); notifies the user when a save finishes enriching even if the app is fully closed; gated correctly on iOS (requires Home Screen install, iOS 16.4+)
- Cycling loading button text during save ("Fetching..." → "Analyzing..." etc.)
- Green glow flash on successful save receipt
- Chime + haptic on successful save, title edit, and tag edit
- Android Share Sheet integration — robust URL extraction across all apps
- "Return to [App]" deep-link button on share-sheet-triggered saves — works via Android Intent URL for 6 known apps (X/Twitter, Instagram, Reddit, LinkedIn, YouTube, Substack); for other sources the button is hidden rather than shown as a dead no-op unless there's real browser history to go back to (see Known Issue #13)
- Clipboard URL auto-paste into save input on tab switch
- Today's saves list below save form (fetched from Supabase, refreshed after each save)
- Delete from Today list with trash icon + confirmation flow
- PWA installable (manifest + icons)
- Vercel (frontend) + Railway (backend) deployments live
- **Search — unified search bar** (single pill input with 🔍 icon, no separate button)
- **Search — personalised suggestion chips** on empty state, derived from user's tag + source history via `/suggestions`; new-user nudge when library is empty
- **Search — content excerpts** on each result card (first ~220 chars of saved text)
- **Search — source + tag filter dropdowns** replacing old pill row; only shown when >1 distinct value present
- **Search — "Show more" pagination** — 5 results at a time, paginating within active filters
- **Search — recent searches** — last 5 queries as dismissible chips, shown when input focused + empty; cleared on sign-out
- **Search — session persistence** — last query + results restored on tab switch / reload within same browser session
- **Search — zero-results CTA** — "Save a page about this →" switches to Save tab
- **Search — shimmer loading bar** — neutral 4px bar, no skeleton cards
- **Security — CORS lockdown** — backend only accepts requests from `CORS_ORIGINS` env var (prod: Vercel domain only)
- **Security — SSRF protection** — `validate_url()`/`is_safe_url()` block private/internal IPs (including IPv4-mapped IPv6 literals, Known Issue #39) before any fetch; `safe_get()` re-validates every redirect hop rather than trusting `follow_redirects=True`, covering all 12 call sites that fetch a user-influenced URL
- **Security — rate limiting** — slowapi, 10/min on `/save`, 30/min on `/search`, plus ~20 other mutating/expensive routes (Known Issue #39), per IP; a separate hand-rolled middleware covers the mounted MCP OAuth sub-app, which slowapi's decorators can't reach
- **Security — RLS hardening** — `save_folders`, `push_subscriptions`, and the three MCP OAuth tables now have RLS enabled with anon/authenticated grants revoked; `saves`' owner-only policy explicitly reaffirmed in version control for the first time (Known Issue #39)
- **Security — zip-bomb protection** — bookmark import reads zip members in bounded chunks against a 100MB total budget instead of trusting attacker-controlled uncompressed-size metadata (Known Issue #39)
- **Observability — Sentry** — error monitoring on both frontend (`@sentry/react`) and backend (`sentry-sdk[fastapi]`); DSN via env vars, silently skips if not set
- **Observability — PostHog** — product analytics on frontend only, loaded lazily via `recall-frontend/src/posthog-lazy.js` (a hand-rolled proxy that queues calls until the real `posthog-js` SDK loads as its own chunk, keeping the ~63KB SDK off the critical render path); tracks `save_confirmed` (fires on save-attempt, the reliable activation/volume signal), `url_saved` (fires only if the user is still watching when background enrichment finishes — a secondary signal, see "Background save enrichment" #1b), `search_performed`, `ask_performed`, `title_edited`, `save_deleted`, `share_sheet_triggered`, `account_deleted` (only on a successful deletion), `user_signed_up`, `x_bookmarks_import_started`/`linkedin_import_started`/`import_finished` (tagged with `source`), `folder_created`, `push_notifications_enabled`, `pwa_installed`, `mcp_connected`; identifies users by Supabase UID plus `email`/`signup_date` person properties; resets on sign-out. Every event is tagged with an `environment` super property (`production` / `staging` / `local`, auto-detected via `window.location.hostname` for local dev) — see `CONTRIBUTING.md` for the staging/production branch workflow this isolation scheme supports.
- **Account deletion** — `DELETE /account` endpoint wipes all saves + deletes auth user; frontend settings panel (⚙ in header) with confirmation step
- **Privacy Policy + Terms of Service** — inline legal view at `/privacy` and `/terms`; footer links on all views; content is factual and minimal
- **Install banner + bottom-of-page fallback button** — persistent, dismissible "Install ReCall" banner below the header on all views; once dismissed, replaced by a small button near the footer. Uses `beforeinstallprompt`/`appinstalled` where available, falls back to platform-specific "Add to Home Screen" instructions on iOS/others
- **iOS Share Sheet via Shortcuts guide** — Settings panel walks iOS users through building a "Save to ReCall" Shortcut that feeds the existing share-sheet URL handling
- **X API integration** — bookmark import via OAuth 2.0 PKCE (primary, restored June 2026 once X moved to pay-per-use pricing), with bookmarklet + file-upload as fallbacks; single-tweet save now reads `GET /2/tweets/:id` via an app-only Bearer token instead of the legacy oEmbed scrape, with Jina/OG/syndication-API enrichment unchanged
- **Reddit support** — `fetch_reddit()` reads posts + top comments via Reddit's official OAuth API (`oauth.reddit.com`, app-only `client_credentials`), replacing a broken generic-scrape path that was saving the site's bot-detection block page as the title
- **Newsletter saving via email forwarding** — Settings → "Save newsletters by email" shows a shared CloudMailin inbound address; forwarding a newsletter there saves it, and a Gmail filter auto-forwards every future issue from a sender automatically. Sender resolved to a ReCall account via `X-Forwarded-For`-then-`From` header matching; HTML parsed with `beautifulsoup4`
- **Notion support** — `fetch_notion()` reads genuinely public Notion pages via Jina Reader; a login-wall signature check (`NOTION_AUTHWALL_SIGNATURES`) honestly detects pages requiring Notion login and degrades to a friendly placeholder rather than saving a confidently-wrong AI-generated title

### Not Yet Built
- Offline support / service worker caching
- Browser extension for desktop saving
- Bulk import / export
- Gemini API budget alert (Google Cloud Console — manual task)
- Uptime monitoring / Railway cold start keep-warm (UptimeRobot — manual task)
- Google OAuth app verification (required for >100 users — needs live privacy policy URL first)
- **Personal knowledge base / LLM Wiki layer** — planned, not yet built:
  - Jina Reader (`r.jina.ai`) as primary article fetch (replaces plain httpx GET; handles JS-rendered pages + "read more" content)
  - `POST /ask` — synthesized Q&A over user's saves (Gemini-2.5-flash over top 8 semantic results)
  - Auto related saves — cosine similarity computed on each save, stored as `related_ids uuid[]` on the `saves` table; shown in receipt card
  - `GET /library` — per-tag AI summaries of user's knowledge clusters
  - `wiki_pages` table — persistent saved insights (pinned synthesis results); shown in Library tab
  - New `find_related_saves` Supabase RPC (pgvector `<=>` similarity, excludes self + media saves)

---

## Deferred Decisions

Things we've discussed and consciously set aside for later — bring these up when the conditions are right.

### Groq as Gemini synthesis alternative

**When to raise this:** If Gemini API usage is running high or costs are a concern.

**Context (discussed April 2026):** The new `/ask` and `/library` endpoints add Gemini-2.5-flash calls for synthesis. At portfolio scale this stays in the free tier (1500 req/day), but if usage grows, Groq is a strong free alternative:
- **Groq free tier:** 14,400 requests/day with Llama 3.3 70B — fast, generous limits
- **Use case:** Replace Gemini-2.5-flash for synthesis tasks only (`/ask`, `/library` summaries, metadata extraction)
- **Keep Gemini for:** `gemini-embedding-001` — no comparable free alternative for 768-dim embeddings
- **Integration:** Groq has an OpenAI-compatible API; swap is a 10-line change in main.py
- **SDK:** `pip install groq`; endpoint is `https://api.groq.com/openai/v1`

### Notion OAuth / personal workspace connection

**When to raise this:** If a user wants ReCall to save their own private/workspace-restricted Notion pages — the ones `NOTION_AUTHWALL_SIGNATURES` correctly and honestly declines to save today, by design.

**Context (discussed July 2026):** First-class Notion support (see "Notion page fetching" #17) only handles genuinely public Notion pages; anything requiring the viewer to be logged into a specific Notion account is detected via the login-wall signature check and gracefully degraded to a `thin_content` placeholder rather than bypassed (impossible without the user's own credentials anyway). Reading private/workspace-restricted pages would require the user to connect their own Notion workspace via OAuth (Notion's public integrations API supports this), so ReCall could fetch content with the user's own authorization instead of an anonymous fetch — and even then, only pages explicitly shared with that integration, not arbitrary pages elsewhere in their workspace. Deferred out of this round's scope — revisit if users ask to save their own private docs.
