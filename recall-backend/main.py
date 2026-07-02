from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import os
import io
import base64
import secrets
import zipfile
from urllib.parse import urlparse
from datetime import datetime, timezone, timedelta
import httpx
import asyncio
import sentry_sdk

from recall_core import (
    supabase,
    gemini_client,
    _executor,
    _NO_THINKING,
    get_user_id,
    validate_url,
    get_embedding,
    process_save,
    process_save_fast,
    do_search,
    do_suggestions,
    do_update_tag,
    do_update_title,
    do_delete_save,
    do_get_folders,
    do_create_folder,
    do_rename_folder,
    do_delete_folder,
    do_set_save_folders,
    process_newsletter_email,
    TWEET_URL_RE,
)

load_dotenv()

sentry_sdk.init(dsn=os.getenv("SENTRY_DSN", ""), traces_sample_rate=0.05)

import sys
sys.stdout.reconfigure(line_buffering=True)

# Imported here (before the FastAPI app is constructed) so its session manager's
# task group can be started from our own lifespan below — a sub-app's own
# `lifespan=` is never triggered by Starlette when it's mounted into a parent app,
# only when run as a top-level ASGI app. Without this, every MCP request fails with
# "Task group is not initialized. Make sure to use run()."
try:
    from mcp_server import mcp as _mcp, mcp_asgi_app
    _mcp_app = mcp_asgi_app()
    _mcp_mount_error = None
except Exception as e:
    _mcp = None
    _mcp_app = None
    _mcp_mount_error = str(e)
    print(f"[mcp] failed to initialize MCP server, /mcp/* will return 503: {e}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if _mcp is not None:
        async with _mcp.session_manager.run():
            yield
    else:
        yield


app = FastAPI(lifespan=lifespan)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:4173").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ASK_MIN_RELEVANCE = 0.5  # cosine similarity floor for /ask context — filters weakly-related saves
MAX_IMPORT_ITEMS = 500  # cap per bulk import job to bound Gemini/Jina usage
IMPORT_DELAY_SECONDS = int(os.getenv("IMPORT_DELAY_SECONDS", "3"))


class SaveRequest(BaseModel):
    url: str
    token: str

class SearchRequest(BaseModel):
    query: str
    token: str

class UpdateTitleRequest(BaseModel):
    title: str
    token: str

class UpdateTagRequest(BaseModel):
    tag: str
    token: str

class DeleteRequest(BaseModel):
    token: str

class SuggestionsRequest(BaseModel):
    token: str

class DeleteAccountRequest(BaseModel):
    token: str

class AskRequest(BaseModel):
    query: str
    token: str

class LibraryRequest(BaseModel):
    token: str

class SaveWikiRequest(BaseModel):
    query: str
    synthesis: str
    source_ids: list[str]
    token: str

class WikiTokenRequest(BaseModel):
    token: str

class ImportStatusRequest(BaseModel):
    token: str

class XConnectRequest(BaseModel):
    token: str
    code: str
    code_verifier: str
    redirect_uri: str

class ScrapedImportRequest(BaseModel):
    token: str
    tweet_ids: list[str]

class ScrapedUrlsImportRequest(BaseModel):
    token: str
    urls: list[str]

class PushSubscription(BaseModel):
    endpoint: str
    keys: dict

class PushSubscribeRequest(BaseModel):
    token: str
    subscription: PushSubscription

class PushUnsubscribeRequest(BaseModel):
    token: str
    endpoint: str

class FolderCreateRequest(BaseModel):
    name: str
    token: str

class FolderRenameRequest(BaseModel):
    name: str
    token: str

class SaveFoldersRequest(BaseModel):
    folder_ids: list[str]
    token: str


@app.post("/save")
@limiter.limit("10/minute")
async def save_url(req: SaveRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    validate_url(req.url)

    result = await process_save_fast(req.url, user_id)
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["detail"])
    return result

@app.post("/push/subscribe")
async def push_subscribe(req: PushSubscribeRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("push_subscriptions").upsert({
        "user_id": user_id,
        "endpoint": req.subscription.endpoint,
        "p256dh": req.subscription.keys.get("p256dh", ""),
        "auth": req.subscription.keys.get("auth", "")
    }, on_conflict="endpoint").execute()
    return {"success": True}

@app.post("/push/unsubscribe")
async def push_unsubscribe(req: PushUnsubscribeRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("push_subscriptions").delete() \
        .eq("user_id", user_id).eq("endpoint", req.endpoint).execute()
    return {"success": True}

@app.post("/webhooks/email-inbound")
async def email_inbound_webhook(request: Request):
    """Receives parsed newsletter emails from CloudMailin (JSON Normalized format) when a
    user forwards (or auto-forwards via a Gmail filter) a newsletter to ReCall's shared
    inbound address. Authenticity is verified via HTTP Basic Auth embedded in the target
    URL configured in the CloudMailin dashboard, not a signature header."""
    secret = os.getenv("EMAIL_WEBHOOK_SECRET", "")
    auth_header = request.headers.get("authorization", "")
    expected = f"Basic {base64.b64encode(f'recall:{secret}'.encode()).decode()}"
    if not secret or not secrets.compare_digest(auth_header, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")

    payload = await request.json()
    result = await process_newsletter_email(payload)
    # Always 200 — CloudMailin retries on non-2xx, and an unmatched/thin-content email
    # isn't a delivery failure on our end, just nothing to save.
    return {"received": True, "result": result}

@app.post("/search")
@limiter.limit("30/minute")
async def search(req: SearchRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    return await do_search(req.query, user_id)

@app.patch("/save/{save_id}/tag")
async def update_tag(save_id: str, req: UpdateTagRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return do_update_tag(save_id, req.tag, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/save/{save_id}")
async def delete_save(save_id: str, req: DeleteRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    return do_delete_save(save_id, user_id)

@app.patch("/save/{save_id}/title")
async def update_title(save_id: str, req: UpdateTitleRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    return do_update_title(save_id, req.title, user_id)

@app.patch("/save/{save_id}/folders")
async def set_save_folders(save_id: str, req: SaveFoldersRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return do_set_save_folders(save_id, req.folder_ids, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/folders")
async def get_folders(token: str):
    try:
        user_id = get_user_id(token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    return do_get_folders(user_id)

@app.post("/folders")
async def create_folder(req: FolderCreateRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return do_create_folder(req.name, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.patch("/folders/{folder_id}")
async def rename_folder(folder_id: str, req: FolderRenameRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        return do_rename_folder(folder_id, req.name, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str, req: DeleteRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    return do_delete_folder(folder_id, user_id)

@app.post("/suggestions")
async def get_suggestions(req: SuggestionsRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return do_suggestions(user_id)

@app.delete("/account")
async def delete_account(req: DeleteAccountRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("saves").delete().eq("user_id", user_id).execute()
    supabase.auth.admin.delete_user(user_id)
    return {"success": True}

@app.post("/ask")
@limiter.limit("20/minute")
async def ask_recall(req: AskRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    query_embedding = await get_embedding(req.query)
    semantic_result = supabase.rpc("match_saves", {
        "query_embedding": query_embedding,
        "match_user_id": user_id,
        "match_count": 8,
        "match_threshold": ASK_MIN_RELEVANCE
    }).execute()

    # match_saves now enforces ASK_MIN_RELEVANCE itself (see
    # recall-backend/sql/010_match_saves_threshold.sql), so every row it returns already
    # clears the relevance bar — this is redundant defense in depth, not the primary filter.
    article_saves = [
        r for r in (semantic_result.data or [])
        if r.get("content_type", "article") == "article"
        and r.get("content_text")
        and r.get("similarity", 1.0) >= ASK_MIN_RELEVANCE
    ]

    relevant_count = len(article_saves)
    if relevant_count < 3:
        return {"synthesis": None, "sources": [], "insufficient": True, "relevant_count": relevant_count}

    context_parts = []
    for row in article_saves[:8]:
        title = row.get("title", "Unknown")
        content = (row.get("content_text") or "")[:600].strip()
        context_parts.append(f"[{title}]\n{content}")
    context = "\n\n---\n\n".join(context_parts)

    prompt = f"""You are a personal knowledge assistant synthesizing information from articles the user has saved to their library. Answer their question in 2-3 concise paragraphs using ONLY what is in the provided articles. Cite sources inline using the article title in square brackets like [Article Title]. If the articles don't contain enough information to answer well, say so briefly.

Articles from the user's library:
{context}

Question: {req.query}"""

    try:
        loop = asyncio.get_running_loop()
        response = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                lambda: gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt,
                    config=_NO_THINKING
                )
            ),
            timeout=25.0
        )
        synthesis = response.text.strip()
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Synthesis timed out — try a more focused question")
    except Exception:
        raise HTTPException(status_code=500, detail="Synthesis failed")

    sources = [
        {
            "id": r["id"],
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "tag": r.get("tag", ""),
            # exact slice fed to the LLM — used by groundcheck for faithfulness evaluation
            "content_snippet": (r.get("content_text") or "")[:600].strip(),
        }
        for r in article_saves[:8]
    ]

    return {"synthesis": synthesis, "sources": sources, "insufficient": False}


@app.post("/library")
@limiter.limit("10/hour")
async def get_library(req: LibraryRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = supabase.table("saves") \
        .select("id, title, tag, content_text, created_at") \
        .eq("user_id", user_id) \
        .eq("content_type", "article") \
        .order("created_at", desc=True) \
        .execute()

    if not result.data:
        return {"library": []}

    from collections import defaultdict
    import json as json_module
    tag_groups = defaultdict(list)
    for row in result.data:
        tag_groups[row.get("tag") or "Other"].append(row)

    library = []

    for tag, saves in sorted(tag_groups.items(), key=lambda x: -len(x[1])):
        count = len(saves)
        recent_titles = [s["title"] for s in saves[:3]]
        word_count = sum(len((s.get("content_text") or "").split()) for s in saves)
        summary = ""
        sub_topics = []

        if count >= 3:
            titles_sample = "\n".join(f"- {s['title']}" for s in saves[:10])
            try:
                prompt = f"""In 1-2 sentences, summarize the key themes across these {count} saved articles under the "{tag}" category. Be specific about recurring topics, not generic.

Titles:
{titles_sample}

Write only the summary, nothing else."""
                response = gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt,
                    config=_NO_THINKING
                )
                summary = response.text.strip()
            except Exception:
                summary = ""

        if count >= 5:
            indexed_titles = "\n".join(f"{i}: {s['title']}" for i, s in enumerate(saves[:20]))
            try:
                sub_prompt = f"""These {min(count, 20)} articles are saved under "{tag}".
Identify 2-4 specific micro-topic clusters (2-5 words each, concrete not generic).
Assign each article index to exactly one cluster.

Articles:
{indexed_titles}

Return JSON only, no markdown fences:
{{"sub_topics": [{{"label": "AI & Language Models", "indices": [0, 3, 7]}}, ...]}}"""
                sub_response = gemini_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=sub_prompt,
                    config=_NO_THINKING
                )
                raw = sub_response.text.strip().strip("```json").strip("```").strip()
                parsed = json_module.loads(raw)
                sub_topics = [
                    {"label": st["label"], "count": len(st.get("indices", []))}
                    for st in parsed.get("sub_topics", [])
                    if st.get("label") and st.get("indices")
                ]
            except Exception:
                sub_topics = []

        library.append({
            "tag": tag,
            "count": count,
            "summary": summary,
            "recent_titles": recent_titles,
            "word_count": word_count,
            "sub_topics": sub_topics,
        })

    return {"library": library}


@app.post("/wiki")
async def save_wiki_insight(req: SaveWikiRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = supabase.table("wiki_pages").insert({
        "user_id": user_id,
        "query": req.query,
        "synthesis": req.synthesis,
        "source_ids": req.source_ids
    }).execute()
    return {"success": True, "id": result.data[0]["id"]}


@app.post("/wiki/list")
async def list_wiki_insights(req: WikiTokenRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    result = supabase.table("wiki_pages") \
        .select("id, query, synthesis, source_ids, created_at") \
        .eq("user_id", user_id) \
        .order("created_at", desc=True) \
        .execute()
    return {"insights": result.data or []}


@app.delete("/wiki/{wiki_id}")
async def delete_wiki_insight(wiki_id: str, req: WikiTokenRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.table("wiki_pages").delete() \
        .eq("id", wiki_id).eq("user_id", user_id).execute()
    return {"success": True}


# ---------------------------------------------------------------------------
# Bookmark import — helpers and endpoints
# ---------------------------------------------------------------------------

def extract_tweet_ids(raw: bytes, filename: str) -> list[str]:
    """Extract tweet IDs from any bookmark export (JSON, CSV, .js, or zip archive)
    by scanning for x.com/twitter.com status URLs. Format-agnostic — works with
    any export tool's output as long as the file contains links back to the posts."""
    texts = []
    if raw[:2] == b"PK":  # zip magic bytes
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                for name in zf.namelist():
                    if name.lower().endswith((".js", ".json", ".csv", ".txt")):
                        texts.append(zf.read(name).decode("utf-8", errors="ignore"))
        except zipfile.BadZipFile:
            texts.append(raw.decode("utf-8", errors="ignore"))
    else:
        texts.append(raw.decode("utf-8", errors="ignore"))

    seen, ids = set(), []
    for text in texts:
        for m in TWEET_URL_RE.finditer(text):
            tid = m.group(1)
            if tid not in seen:
                seen.add(tid)
                ids.append(tid)
    return ids


def tweet_id_to_url(tweet_id: str) -> str:
    return f"https://x.com/i/web/status/{tweet_id}"


async def run_import_job(job_id: str, user_id: str, urls: list[str]):
    """Background job runner — source-agnostic. Callers (X tweet IDs, scraped LinkedIn
    URLs, etc.) convert their own identifiers to full URLs before calling this."""
    succeeded = duplicates = failed = skipped = 0
    for i, url in enumerate(urls):
        try:
            validate_url(url)
            result = await process_save(url, user_id)
            if result.get("duplicate"):
                duplicates += 1
            elif result.get("thin_content"):
                skipped += 1
            elif result.get("success"):
                succeeded += 1
            else:
                failed += 1
        except Exception as e:
            print(f"[import {job_id}] item {url} failed: {e}", flush=True)
            failed += 1

        try:
            supabase.table("import_jobs").update({
                "processed": i + 1, "succeeded": succeeded, "duplicates": duplicates,
                "failed": failed, "skipped": skipped,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", job_id).execute()
        except Exception as e:
            print(f"[import {job_id}] status update failed: {e}", flush=True)

        if i < len(urls) - 1:
            await asyncio.sleep(IMPORT_DELAY_SECONDS)

    try:
        supabase.table("import_jobs").update({
            "status": "completed",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", job_id).execute()
    except Exception as e:
        print(f"[import {job_id}] final status update failed: {e}", flush=True)


@app.post("/import/x-bookmarks")
@limiter.limit("2/hour")
async def import_x_bookmarks(request: Request, token: str = Form(...), file: UploadFile = File(...)):
    try:
        user_id = get_user_id(token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    raw = await file.read()
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 50 MB)")

    all_ids = extract_tweet_ids(raw, file.filename or "")
    if not all_ids:
        raise HTTPException(
            status_code=400,
            detail="No X/Twitter bookmark links found in this file. Make sure you exported with a tool that includes links to the posts."
        )

    existing_job = supabase.table("import_jobs") \
        .select("id").eq("user_id", user_id).eq("status", "running").limit(1).execute()
    if existing_job.data:
        raise HTTPException(status_code=409, detail="An import is already in progress")

    tweet_ids = all_ids[:MAX_IMPORT_ITEMS]
    job = supabase.table("import_jobs").insert({
        "user_id": user_id, "source": "x_bookmarks", "status": "running",
        "total": len(tweet_ids), "processed": 0, "succeeded": 0,
        "duplicates": 0, "skipped": 0, "failed": 0,
    }).execute()
    job_id = job.data[0]["id"]

    asyncio.create_task(run_import_job(job_id, user_id, [tweet_id_to_url(t) for t in tweet_ids]))

    return {
        "job_id": job_id,
        "total": len(tweet_ids),
        "total_found": len(all_ids),
        "capped": len(all_ids) > len(tweet_ids),
    }


@app.post("/import/status/{job_id}")
async def import_status(job_id: str, req: ImportStatusRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = supabase.table("import_jobs").select("*") \
        .eq("id", job_id).eq("user_id", user_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = result.data[0]
    # Surface stalled jobs — asyncio task dies if Railway restarts mid-import
    if job["status"] == "running":
        updated = datetime.fromisoformat(job["updated_at"])
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - updated > timedelta(minutes=2):
            job["status"] = "stalled"
    return job


@app.post("/import/jobs/latest")
async def latest_import_job(req: ImportStatusRequest):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    result = supabase.table("import_jobs").select("*") \
        .eq("user_id", user_id).order("created_at", desc=True).limit(1).execute()
    return {"job": result.data[0] if result.data else None}


@app.post("/import/x-connect")
@limiter.limit("5/hour")
async def import_x_connect(req: XConnectRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    client_id = os.getenv("TWITTER_CLIENT_ID")
    client_secret = os.getenv("TWITTER_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="X import not configured")

    # Exchange authorization code for X access token
    async with httpx.AsyncClient(timeout=15) as client:
        token_res = await client.post(
            "https://api.twitter.com/2/oauth2/token",
            data={
                "grant_type": "authorization_code",
                "code": req.code,
                "redirect_uri": req.redirect_uri,
                "code_verifier": req.code_verifier,
                "client_id": client_id,
            },
            auth=(client_id, client_secret),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if token_res.status_code != 200:
        print(f"[x-connect] token exchange failed: {token_res.status_code} {token_res.text}", flush=True)
        raise HTTPException(status_code=400, detail="X authorization failed — try connecting again")
    x_token = token_res.json()["access_token"]

    # Get X user ID
    async with httpx.AsyncClient(timeout=10, headers={"Authorization": f"Bearer {x_token}"}) as client:
        me_res = await client.get("https://api.twitter.com/2/users/me")
    if me_res.status_code != 200:
        print(f"[x-connect] /users/me failed: {me_res.status_code} {me_res.text}", flush=True)
        raise HTTPException(status_code=400, detail=f"Could not fetch X user info (status {me_res.status_code})")
    x_user_id = me_res.json()["data"]["id"]

    # Paginate through bookmarks to collect all tweet IDs
    tweet_ids = []
    next_token = None
    async with httpx.AsyncClient(timeout=15, headers={"Authorization": f"Bearer {x_token}"}) as client:
        while len(tweet_ids) < MAX_IMPORT_ITEMS:
            params = {"max_results": 100}
            if next_token:
                params["pagination_token"] = next_token
            bm_res = await client.get(
                f"https://api.twitter.com/2/users/{x_user_id}/bookmarks",
                params=params,
            )
            if bm_res.status_code != 200:
                print(f"[x-connect] bookmarks fetch failed: {bm_res.status_code} {bm_res.text}", flush=True)
                break
            body = bm_res.json()
            for item in body.get("data") or []:
                tweet_ids.append(item["id"])
            next_token = body.get("meta", {}).get("next_token")
            if not next_token:
                break

    total_found = len(tweet_ids)
    if total_found == 0:
        raise HTTPException(status_code=404, detail="No bookmarks found on this X account")

    existing = supabase.table("import_jobs") \
        .select("id").eq("user_id", user_id).eq("status", "running").limit(1).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="An import is already in progress")

    capped_ids = tweet_ids[:MAX_IMPORT_ITEMS]
    job = supabase.table("import_jobs").insert({
        "user_id": user_id, "source": "x_oauth", "status": "running",
        "total": len(capped_ids), "processed": 0, "succeeded": 0,
        "duplicates": 0, "skipped": 0, "failed": 0,
    }).execute()
    job_id = job.data[0]["id"]

    asyncio.create_task(run_import_job(job_id, user_id, [tweet_id_to_url(t) for t in capped_ids]))

    return {
        "job_id": job_id,
        "total": len(capped_ids),
        "total_found": total_found,
        "capped": total_found > len(capped_ids),
    }


@app.post("/import/x-scraped")
@limiter.limit("5/hour")
async def import_x_scraped(req: ScrapedImportRequest, request: Request):
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    clean_ids = list(dict.fromkeys(tid for tid in req.tweet_ids if tid.isdigit()))
    if not clean_ids:
        raise HTTPException(status_code=400, detail="No valid bookmark IDs found")

    existing = supabase.table("import_jobs") \
        .select("id").eq("user_id", user_id).eq("status", "running").limit(1).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="An import is already in progress")

    capped_ids = clean_ids[:MAX_IMPORT_ITEMS]
    job = supabase.table("import_jobs").insert({
        "user_id": user_id, "source": "x_scraped", "status": "running",
        "total": len(capped_ids), "processed": 0, "succeeded": 0,
        "duplicates": 0, "skipped": 0, "failed": 0,
    }).execute()
    job_id = job.data[0]["id"]

    asyncio.create_task(run_import_job(job_id, user_id, [tweet_id_to_url(t) for t in capped_ids]))

    return {
        "job_id": job_id,
        "total": len(capped_ids),
        "total_found": len(clean_ids),
        "capped": len(clean_ids) > len(capped_ids),
    }


@app.post("/import/urls-scraped")
@limiter.limit("5/hour")
async def import_urls_scraped(req: ScrapedUrlsImportRequest, request: Request):
    """Generic, source-agnostic import endpoint — accepts any scraped post URLs
    (currently used for LinkedIn saved posts; bookmarklet-based, same pattern as
    /import/x-scraped). Each URL gets validated for SSRF inside run_import_job."""
    try:
        user_id = get_user_id(req.token)
    except:
        raise HTTPException(status_code=401, detail="Invalid token")

    clean_urls = list(dict.fromkeys(u for u in req.urls if u.startswith("http")))
    if not clean_urls:
        raise HTTPException(status_code=400, detail="No valid URLs found")

    existing = supabase.table("import_jobs") \
        .select("id").eq("user_id", user_id).eq("status", "running").limit(1).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="An import is already in progress")

    capped_urls = clean_urls[:MAX_IMPORT_ITEMS]
    job = supabase.table("import_jobs").insert({
        "user_id": user_id, "source": "url_scraped", "status": "running",
        "total": len(capped_urls), "processed": 0, "succeeded": 0,
        "duplicates": 0, "skipped": 0, "failed": 0,
    }).execute()
    job_id = job.data[0]["id"]

    asyncio.create_task(run_import_job(job_id, user_id, capped_urls))

    return {
        "job_id": job_id,
        "total": len(capped_urls),
        "total_found": len(clean_urls),
        "capped": len(clean_urls) > len(capped_urls),
    }


# ---------------------------------------------------------------------------
# Remote MCP server (Claude/ChatGPT connector) — OAuth 2.1
# ---------------------------------------------------------------------------

class McpAuthorizeCompleteRequest(BaseModel):
    supabase_access_token: str
    client_id: str
    redirect_uri: str
    state: str | None = None
    code_challenge: str
    code_challenge_method: str = "S256"
    scope: str | None = None
    resource: str | None = None

if _mcp_app is not None:
    @app.post("/mcp/authorize/complete")
    async def mcp_authorize_complete(req: McpAuthorizeCompleteRequest):
        try:
            user_id = get_user_id(req.supabase_access_token)
        except:
            raise HTTPException(status_code=401, detail="Invalid Supabase session")

        client_row = supabase.table("mcp_oauth_clients") \
            .select("redirect_uris").eq("client_id", req.client_id).limit(1).execute()
        if not client_row.data:
            raise HTTPException(status_code=400, detail="Unknown client")
        # Never trust the frontend's echoed redirect_uri — require an exact match
        # against what this client registered. This is the actual open-redirect fix.
        if req.redirect_uri not in (client_row.data[0].get("redirect_uris") or []):
            raise HTTPException(status_code=400, detail="redirect_uri not registered for this client")

        code = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        supabase.table("mcp_auth_codes").insert({
            "code": code,
            "client_id": req.client_id,
            "user_id": user_id,
            "redirect_uri": req.redirect_uri,
            "redirect_uri_provided_explicitly": True,
            "code_challenge": req.code_challenge,
            "code_challenge_method": req.code_challenge_method,
            "scope": req.scope,
            "resource": req.resource,
            "expires_at": expires_at,
        }).execute()

        from mcp.server.auth.provider import construct_redirect_uri
        return {"redirect_uri": construct_redirect_uri(req.redirect_uri, code=code, state=req.state)}

    @app.get("/mcp/connections")
    async def list_mcp_connections(token: str):
        try:
            user_id = get_user_id(token)
        except:
            raise HTTPException(status_code=401, detail="Invalid token")
        rows = supabase.table("mcp_tokens") \
            .select("client_id, created_at, mcp_oauth_clients(client_name)") \
            .eq("user_id", user_id).eq("revoked", False) \
            .order("created_at", desc=True).execute()
        seen = set()
        connections = []
        for r in rows.data or []:
            if r["client_id"] in seen:
                continue
            seen.add(r["client_id"])
            connections.append({
                "client_id": r["client_id"],
                "client_name": (r.get("mcp_oauth_clients") or {}).get("client_name"),
                "connected_at": r["created_at"],
            })
        return {"connections": connections}

    class RevokeConnectionRequest(BaseModel):
        token: str

    @app.post("/mcp/connections/{client_id}/revoke")
    async def revoke_mcp_connection(client_id: str, req: RevokeConnectionRequest):
        try:
            user_id = get_user_id(req.token)
        except:
            raise HTTPException(status_code=401, detail="Invalid token")
        supabase.table("mcp_tokens").update({"revoked": True}) \
            .eq("client_id", client_id).eq("user_id", user_id).execute()
        return {"success": True}

@app.get("/")
async def root():
    return {"status": "ReCall backend running"}


if _mcp_app is not None:
    # Mounted last (after every other route, including "/") so it only catches
    # paths not matched above — OAuth endpoints (/authorize, /token, /register,
    # /revoke, /.well-known/oauth-authorization-server) and the MCP protocol
    # endpoint (/mcp) all live at backend root, per RFC 8414's expectation for
    # an issuer with no path component. Starlette matches routes in registration
    # order, so a mount at "/" registered earlier would shadow "/" and every
    # other route defined after it.
    app.mount("/", _mcp_app)
