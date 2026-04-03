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
│   │   ├── index.css           ← global CSS variables and base styles
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
```

**On Vercel**, set `VITE_BACKEND_URL` to `https://recall-production-9941.up.railway.app` via the Vercel environment variable dashboard — do NOT hardcode it.

### Backend — `recall-backend/.env`

```
SUPABASE_URL=https://ompfoouatzknuidnccsz.supabase.co
SUPABASE_SERVICE_KEY=<service role key — NEVER expose to client>
GEMINI_API_KEY=<Gemini API key>
```

**On Railway**, these are set as environment variables in the Railway dashboard.

---

## How Each Major Feature Works

### 1. Save a URL

**Frontend (`App.jsx` → `handleSave`)**
1. Validates that the URL starts with `http://` or `https://`
2. POSTs `{ url, token }` to `BACKEND/save` (token is the Supabase session JWT)
3. Shows "Saved from {Source} ✓" or an error message

**Backend (`main.py` → `POST /save`)**
1. Verifies the JWT via `supabase.auth.get_user(token)` to get `user_id`
2. **If tweet** (`x.com` or `twitter.com`): calls Twitter's free oEmbed API at `publish.twitter.com/oembed` — strips HTML tags to get plain text and author name. No auth required.
   **If Instagram** (`instagram.com`): fetches the embed page at `instagram.com/p/SHORTCODE/embed/captioned/` with a mobile User-Agent. Extracts all visible text (skipping script/style tags), strips follower count UI boilerplate, and uses the result as the caption. Extracts author from JSON username fields or profile href links. Instagram CDN blocks direct image fetches so thumbnail vision is skipped. Works for public posts only; no API credentials needed.
3. **Otherwise**: fetches the page with `httpx` (with a browser User-Agent), strips `<script>`/`<style>` tags, extracts plain text (up to 5000 chars) and `<title>`
4. Calls `extract_og_tags()`: parses all `<meta>` tags from the raw HTML to extract `og:title`, `og:description`, `og:image`, and `description`. These are served even by JS-heavy sites like LinkedIn. Uses `og:title` as a better fallback title when `<title>` is generic.
5. **Image analysis** (triggered when `len(clean_text) < 400` and `og:image` exists): calls `analyze_image()` which fetches the image bytes and passes them to `gemini-2.5-flash` vision to get a 2–3 sentence description of what's in the image.
6. Builds `extra_context` from `og:description` + image description. Appends it to `content_text` (so full-text search benefits) and passes it separately to the AI tagging prompt.
7. Calls `extract_save_metadata()`: sends raw title + up to 1500 chars of content + up to 800 chars of extra context to `gemini-2.5-flash`. The model returns exactly 3 lines:
   - Line 1: Concise title (≤8 words)
   - Line 2: Author name or org ("Unknown" if not found)
   - Line 3: Category tag (Tech / Product / Business / Finance / Health / Personal / Other)
   - Display title is formatted as `"Title · Author"` (or just title if author is Unknown)
8. Calls `get_embedding()`: POSTs directly to `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent` with combined `title + content_text` (which now includes og/image context), capped at 8000 chars, returns 768-dim float array
9. Inserts row into `saves` table: `{ user_id, url, title, content_text, embedding, tag }`

### 2. Search

**Frontend (`App.jsx` → `handleSearch`)**
1. POSTs `{ query, token }` to `BACKEND/search`
2. Renders up to 5 result cards: tag, title, URL, match %
3. If results span >1 source (Twitter, Reddit, etc.), shows source filter pills

**Backend (`main.py` → `POST /search`)**

Hybrid search with Reciprocal Rank Fusion (RRF):
1. Embeds the query using `get_embedding()`
2. **Semantic search**: Supabase RPC `match_saves` with query embedding, `match_user_id`, `match_count=20`. Returns cosine-similarity ranked results.
3. **Full-text search**: `saves` table filtered with `.filter("content_text", "fts", req.query)`, limit 20
4. **RRF fusion** (k=60): scores `1/(k + rank + 1)` for each result per list, sums across lists — boosts items appearing in both
5. Takes top 5 fused results, normalizes scores to 0–1 for the frontend % display

### 3. Android Share Sheet

**`manifest.json` config:**
```json
"share_target": {
  "action": "/",
  "method": "GET",
  "params": { "url": "url", "text": "text", "title": "title" }
}
```
When Android shares a URL to ReCall, it opens `/?url=<shared-url>`.

**Frontend handling (`App.jsx` → `useEffect` on mount):**
1. Reads `window.location.search` for `?url=` or `?text=` params
2. If a valid `http` URL is found, stores it in `sessionStorage` as `pendingUrl` and switches to "save" view
3. After auth resolves (or on `onAuthStateChange`), if there's a `pendingUrl` and a logged-in user, auto-calls `handleSave()` and clears `pendingUrl`
4. Handles the race condition where the share arrives before auth loads

### 4. Clipboard Detection

On the Save tab (and on initial load if not a share-sheet trigger), `checkClipboard()` runs:
1. Calls `navigator.clipboard.readText()` — requires focus + user permission; silently ignores errors
2. If clipboard contains `http://` or `https://` URL, sets `clipboardUrl` state
3. A banner appears: "Copied from {Source}" + "Save this" button
4. Tapping "Save this" calls `handleSave(clipboardUrl)` and clears the banner

### 5. Authentication

- Google OAuth via Supabase Auth
- `signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } })`
- After OAuth redirect, Supabase injects session tokens into the app
- `supabase.auth.getSession()` + `onAuthStateChange` listener keep `user` state in sync
- The `anon` key is safe to expose — RLS enforces per-user data isolation
- The backend uses the **service role key** (bypasses RLS) but manually enforces ownership via verified JWT `user_id`

### 6. Source Label Detection

`getSourceLabel(url)` maps URLs to human-readable source names:
- `twitter.com` or `x.com` → "X (Twitter)"
- `linkedin.com` → "LinkedIn"
- `reddit.com` → "Reddit"
- `youtube.com` or `youtu.be` → "YouTube"
- `substack.com` → "Substack"
- Anything else → hostname with first letter capitalized (e.g. "medium.com" → "Medium")
- Fallback → "Page"

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

### Backend — Railway

- **Builder**: Nixpacks (auto-detects Python from `requirements.txt`)
- **Start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Configured via `railway.json` and `Procfile` (both specify the same start command)
- **Environment variables** in Railway dashboard:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
  - `GEMINI_API_KEY`

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
| Success message | `#4ade80` (green) |
| Error message | `#ef4444` (red) |

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

6. **Clipboard API silently fails** — requires page focus and user permission. The `try/catch` around it is correct and intentional — don't remove it or replace with alerts.

7. **Tweet fetching uses oEmbed (no auth)** — only works for public tweets. The HTML-to-text stripping is regex-based (not a full parser), which is intentional for simplicity.

8. **`vite-plugin-pwa` is NOT installed** — PWA is manual (manifest.json only). No service worker exists. The app is installable but not offline-capable.

9. **`App.css` is not used by the app** — it's leftover Vite boilerplate. The real styles are inline in `App.jsx`.

10. **React 19 + Vite 8** — cutting-edge versions; check plugin/library compatibility before adding new dependencies.

11. **Gemini model name** — the backend uses `"gemini-2.5-flash"` (not `"gemini-2.5-flash-preview-04-17"` which was an older preview name). Keep this consistent.

---

## Current Status

### Working
- Google OAuth sign-in / sign-out
- Saving URLs: web pages and X/Twitter tweets
- AI-generated title with author attribution (`"Title · Author"`)
- Auto-categorization into 7 tags (Tech, Product, Business, Finance, Health, Personal, Other)
- Hybrid semantic + full-text search with Reciprocal Rank Fusion
- Source-based result filter pills
- Match % display per result card
- Android Share Sheet integration (auto-saves on return from share)
- Clipboard URL detection on Save tab
- PWA installable (manifest + icons)
- Vercel (frontend) + Railway (backend) deployments live

### Not Yet Built
- Offline support / service worker caching
- Delete or edit saved items
- Browse / view all saves (no list view — only search)
- Pagination for large save libraries
- iOS Share Sheet (not supported by PWA spec yet)
- Browser extension for desktop saving
- Filtering search by source or tag before searching
- Bulk import / export
- Analytics or usage tracking
