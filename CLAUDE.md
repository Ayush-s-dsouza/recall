# ReCall — Complete Project Context

> **Keep this file up to date.** Every significant change to the stack, features, deployment, or known issues should be reflected here. This is the sole source of truth read at the start of every Claude Code session.

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
| Embeddings | Gemini `gemini-embedding-001` (768 dims, via direct REST — NOT the SDK) |
| AI tagging | Gemini `gemini-2.5-flash` (via `google-genai` SDK) |
| Analytics | PostHog (`posthog-js` — frontend only) |
| Error monitoring | Sentry (`@sentry/react` frontend, `sentry-sdk[fastapi]` backend) |
| Rate limiting | slowapi (per-IP, on `/save` and `/search`) |
| Frontend deploy | Vercel |
| Backend deploy | Railway (Nixpacks builder) |

---

## Folder Structure

```
ReCall/
├── CLAUDE.md                   ← this file
├── vercel.json                 ← SPA fallback rewrites (lives at root; Vercel root dir = recall-frontend)
├── .gitignore
├── recall-frontend/            ← React PWA
│   ├── src/
│   │   ├── App.jsx             ← entire frontend (single component file)
│   │   ├── main.jsx            ← React entry point
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
    ├── main.py                 ← entire backend (single file)
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
```

**On Vercel**, set `VITE_BACKEND_URL` to `https://recall-production-9941.up.railway.app` via the Vercel environment variable dashboard — do NOT hardcode it. `VITE_SENTRY_DSN` and `VITE_POSTHOG_KEY` are also set in Vercel dashboard. Both are public-safe by design.

### Backend — `recall-backend/.env`

```
SUPABASE_URL=https://ompfoouatzknuidnccsz.supabase.co
SUPABASE_SERVICE_KEY=<service role key — NEVER expose to client>
GEMINI_API_KEY=<Gemini API key>
SENTRY_DSN=<Sentry backend DSN>
CORS_ORIGINS=https://recall-iota-six.vercel.app,http://localhost:5173
```

**On Railway**, these are set as environment variables in the Railway dashboard. `CORS_ORIGINS` is comma-separated — update if the frontend domain ever changes.

---

## Backend API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/save` | Save a URL (full pipeline) |
| `POST` | `/search` | Hybrid semantic + FTS search |
| `POST` | `/suggestions` | Personalised search chip suggestions |
| `PATCH` | `/save/{id}/title` | Update a save's display title |
| `PATCH` | `/save/{id}/tag` | Update a save's category tag |
| `DELETE` | `/save/{id}` | Delete a save |
| `DELETE` | `/account` | Delete all user saves + auth account |
| `GET` | `/` | Health check |

All mutating endpoints verify the Supabase JWT and enforce `user_id` ownership before touching any row.

---

## How Each Major Feature Works

### 1. Save a URL

**Frontend (`App.jsx` → `handleSave(url, fromShareSheet = false)`)**
1. Validates URL starts with `http://` or `https://`; shows error and returns early if not
2. Immediately sets an optimistic `saveReceipt` with `{ url, optimistic: true }` — renders a shimmer card at once
3. Button text cycles through `["Fetching...", "Reading...", "Analyzing...", "Almost there..."]` every 800 ms via a `useEffect` on `loading`
4. POSTs `{ url, token }` to `BACKEND/save`
5. **On duplicate** (`data.duplicate === true`): sets receipt to `{ ...data, duplicate: true }` — shows amber "Already in ReCall" card with original save date. No chime, no re-save.
6. **On success**: clears input, sets full receipt `{ title, tag, id, url, fromShareSheet }`, refreshes Today list, plays chime + vibrates, flashes green box-shadow glow for 1.5 s
7. **On failure**: clears receipt, shows red error message

**Backend (`main.py` → `POST /save`)**
1. Verifies JWT → `user_id`
2. **Duplicate check first**: queries `saves` table for matching `url + user_id`. If found, returns `{ duplicate: True, id, title, tag, created_at }` immediately — no pipeline work.
3. **If tweet** (`x.com`/`twitter.com`): oEmbed API at `publish.twitter.com/oembed` — strips HTML to get plain text + author. No auth required.
   **If Instagram** (`instagram.com`): fetches `instagram.com/p/SHORTCODE/embed/captioned/` with mobile UA. Extracts visible text, strips UI boilerplate, extracts author from JSON/href. Instagram CDN blocks image fetches so vision is skipped. Public posts only.
4. **Otherwise**: fetches page with `httpx` (browser UA), strips `<script>`/`<style>`, extracts plain text (≤5000 chars) and `<title>`
5. Calls `extract_og_tags()`: parses `<meta>` tags for `og:title`, `og:description`, `og:image`, `description`
6. **Image analysis** (when `len(clean_text) < 400` and `og:image` exists): passes image bytes to `gemini-2.5-flash` vision for a 2–3 sentence description
7. Calls `extract_save_metadata()`: sends title + content + extra context to `gemini-2.5-flash` → returns exactly 3 lines: concise title, author, category tag. Display title formatted as `"Title · Author"` (or just title if Unknown)
8. Calls `get_embedding()`: direct REST POST to `gemini-embedding-001`, returns 768-dim float array
9. Inserts into `saves` table, captures `result.data[0]["id"]`, returns `{ success, title, tag, id }`

### 2. Save Receipt Card

After a successful save, a card replaces the input area showing:
- **Tag pill** — tappable; opens a 7-pill inline picker to change the category. Selecting a new tag PATCHes `/save/{id}/tag` and updates the Today list in-place.
- **Title** — editable via ✎ pencil icon → input + green ✓ button. Confirming PATCHes `/save/{id}/title`, updates the Today list, plays chime + vibrates.
- **URL** + **"Saved ✓"** footer
- **"← Return to [Source]"** link — shown only when the save was triggered via the share sheet. Implemented as `<a href="twitter://timeline">` (not programmatic `window.location.href`) — see Known Issues #13.

Receipt clears when the user starts typing a new URL into the input.

### 3. Today's Saves

A scrollable list below the save form showing all saves from the current calendar day. Fetched directly from Supabase (anon key + RLS) — no backend endpoint needed:
```js
supabase.from("saves").select("id, url, title, tag")
  .gte("created_at", today.toISOString())
  .order("created_at", { ascending: false }).limit(20)
```
Refreshed on: user sign-in, after each successful save.

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

**Backend (`main.py` → `POST /search`)**

Hybrid search with Reciprocal Rank Fusion (RRF):
1. Embeds the query using `get_embedding()`
2. **Semantic search**: Supabase RPC `match_saves` — cosine similarity, top 20
3. **Full-text search**: `saves` table, selects `id, url, title, tag, created_at, content_text`, limit 20
4. **RRF fusion** (k=60): `1/(k + rank + 1)` per list, summed — boosts items in both
5. Top 20 fused results returned (frontend paginates with `displayCount`)
6. Each result gets an `excerpt` field: first ~220 chars of `content_text`, trimmed to word boundary with `…`
7. `content_text` and `embedding` are stripped from the response before sending to client

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

`getSourceLabel(url)` maps URLs to human-readable names: X (Twitter), LinkedIn, Reddit, YouTube, Substack, or hostname-capitalised fallback.

`getAppScheme(url)` maps the same sources to native app deep link schemes used by the "Return to" button:
- X/Twitter → `twitter://timeline`
- Instagram → `instagram://feed`
- Reddit → `reddit://front`
- LinkedIn → `linkedin://feed`
- YouTube → `youtube://`
- Substack → `substack://`
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

iOS/WebKit doesn't implement the Web Share Target API, so there's no way for a PWA to register as a native Share Sheet target without an App Store app + Share Extension. Instead, on iOS (`isIOS`), the Settings panel has a "Save from any app" section (`shortcutGuideOpen` state) with a 6-step guide for building a **"Save to ReCall" Shortcut** in the iOS Shortcuts app:
1. Create a new shortcut, enable "Use with Share Sheet" (type: URLs)
2. Add a "URL" action: `https://recall-iota-six.vercel.app/?url=` + Shortcut Input
3. Add an "Open URLs" action using that URL
4. Name it "Save to ReCall"

Once built, `Share → Save to ReCall` opens ReCall with `?url=<link>`, which the existing `extractSharedUrl`/`pendingUrl` flow (see #7) already handles via the `url` param fast-path — no backend or manifest changes needed. The install onboarding overlay's iOS branch points users to this guide in ⚙ Settings instead of the old "coming soon" placeholder.

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
| tag | text | Tech / Product / Business / Finance / Health / Personal / Other |
| content_type | text | `article` (default) or `video` / `image` for media URLs |
| related_ids | uuid[] | IDs of semantically related saves (best-effort, may be null) |
| created_at | timestamptz | auto |

RLS is enabled — policies restrict all access to `user_id = auth.uid()`.

### RPC: `match_saves`

Postgres function using `pgvector` cosine similarity. Parameters:
- `query_embedding vector(768)`
- `match_user_id uuid`
- `match_count int`

Returns rows ordered by `embedding <=> query_embedding` (cosine distance), filtered to the user's rows.

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
- **Start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Configured via `railway.json` and `Procfile` (both specify the same start command)
- **Environment variables** in Railway dashboard:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
  - `GEMINI_API_KEY`
  - `SENTRY_DSN`
  - `CORS_ORIGINS`

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

7. **Tweet fetching uses oEmbed (no auth)** — only works for public tweets. The HTML-to-text stripping is regex-based (not a full parser), intentional for simplicity.

8. **`vite-plugin-pwa` is NOT installed** — PWA is manual (manifest.json only). No service worker exists. The app is installable but not offline-capable.

9. **`App.css` is not used by the app** — it's leftover Vite boilerplate. All styles are inline in `App.jsx` via the `styles` object at the bottom of the file.

10. **React 19 + Vite 8** — cutting-edge versions; check plugin/library compatibility before adding new dependencies.

11. **Gemini model name** — the backend uses `"gemini-2.5-flash"`. Keep this consistent.

12. **`fromShareSheet` must be a parameter, not state** — `handleSave` is defined before the `useEffect` state updates resolve. Reading `viaShareSheet` state inside `handleSave` would always see the initial `false` value (stale closure). The flag is passed as `handleSave(pending, isViaShareSheet)` using the local variable from the useEffect scope.

13. **"Return to [App]" button uses Android Intent URLs** — Chrome standalone mode blocks both programmatic navigation (`window.location.href`) AND `<a href="custom-scheme://...">` to custom app schemes. The only reliable fix is Android Intent URL format: `intent://{host}{pathname}#Intent;scheme=https;package={app.package.id};end`. This goes through Android's intent system directly. The button must remain an `<a>` tag (not a `<button>` with `onClick`) and must NOT call `e.preventDefault()`.

14. **Share sheet URL extraction must handle embedded URLs** — different apps encode the shared URL differently. LinkedIn prepends the article title to the `text` param (e.g., `"Article title\nhttps://..."`). The `extractSharedUrl()` helper in the `useEffect` scans all three params (`url`, `text`, `title`) and uses a regex fallback to find the URL anywhere in the string. Don't simplify this back to a plain `startsWith("http")` check.

15. **Duplicate check happens before the full pipeline** — `/save` queries for an existing row with the same `url + user_id` before fetching the page or calling Gemini. If found, returns `{ duplicate: True, ... }` immediately. The frontend shows an amber receipt and plays no chime. There is no re-save path.

16. **`handleSearch` uses `overrideQuery` parameter, not `query` state** — chip clicks (example chips, recent searches) call `handleSearch(chipText)` directly. Reading `query` state inside the function would see the pre-update value (stale closure). Always pass the intended query string as `overrideQuery` when calling from chip click handlers.

17. **`get_source_label()` exists in both frontend and backend** — the frontend `getSourceLabel(url)` (in `App.jsx`) and the backend `get_source_label(url)` (in `main.py`) must stay in sync. The backend version is used by `/suggestions` to tally source frequency. If new sources are added to one, add to the other.

18. **Search session persistence uses `sessionStorage`, not `localStorage`** — `recall_last_query` and `recall_last_results` survive tab switching and page reload but are cleared when the browser session ends. `recall_suggestions` is also session-scoped so chips refresh on next login. `recall_recent_searches` uses `localStorage` so it persists across sessions until sign-out.

19. **Filter dropdowns reset `displayCount`** — both the Source and Tag dropdowns call `setDisplayCount(5)` on change. This is intentional: switching filters should always start from the top of the filtered set, not mid-paginated.

20. **Install banner and bottom button are mutually exclusive, gated by `showInstallUI`** — `recall_install_banner_dismissed` (localStorage) switches the UI from the banner to the bottom button; `recall_installed` (localStorage, set on `appinstalled`) hides both permanently. `deferredInstallPrompt` is single-use — call `.prompt()` then clear it immediately after `.userChoice` resolves. Don't gate either UI element on `isStandalone` alone — also check `justInstalled`/`recall_installed`, since `appinstalled` can fire before the page re-evaluates `display-mode: standalone`.

---

## Current Status

### Working
- Google OAuth sign-in / sign-out
- Saving URLs: web pages, X/Twitter tweets, Instagram posts, LinkedIn articles
- AI-generated title with author attribution (`"Title · Author"`)
- Inline title editing from the save receipt card
- Inline tag editing from the save receipt card (7-category pill picker)
- Auto-categorization into 7 tags (Tech, Product, Business, Finance, Health, Personal, Other)
- Duplicate URL detection — shows "Already in ReCall" with original save date, no re-save
- Optimistic UI — shimmer receipt appears instantly on save tap
- Cycling loading button text during save ("Fetching..." → "Analyzing..." etc.)
- Green glow flash on successful save receipt
- Chime + haptic on successful save, title edit, and tag edit
- Android Share Sheet integration — robust URL extraction across all apps
- "Return to [App]" deep-link button on share-sheet-triggered saves (in progress — not fully reliable on all devices yet)
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
- **Security — SSRF protection** — `validate_url()` blocks private/internal IPs before any fetch; guards both user-supplied URLs and `og:image` URLs
- **Security — rate limiting** — slowapi, 10/min on `/save`, 30/min on `/search`, per IP
- **Observability — Sentry** — error monitoring on both frontend (`@sentry/react`) and backend (`sentry-sdk[fastapi]`); DSN via env vars, silently skips if not set
- **Observability — PostHog** — product analytics on frontend; tracks `url_saved`, `search_performed`, `tag_edited`, `title_edited`, `save_deleted`, `share_sheet_triggered`, `account_deleted`; identifies users by Supabase UID; resets on sign-out
- **Account deletion** — `DELETE /account` endpoint wipes all saves + deletes auth user; frontend settings panel (⚙ in header) with confirmation step
- **Privacy Policy + Terms of Service** — inline legal view at `/privacy` and `/terms`; footer links on all views; content is factual and minimal
- **Install banner + bottom-of-page fallback button** — persistent, dismissible "Install ReCall" banner below the header on all views; once dismissed, replaced by a small button near the footer. Uses `beforeinstallprompt`/`appinstalled` where available, falls back to platform-specific "Add to Home Screen" instructions on iOS/others
- **iOS Share Sheet via Shortcuts guide** — Settings panel walks iOS users through building a "Save to ReCall" Shortcut that feeds the existing share-sheet URL handling

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
