-- STEP 0 — run this first, read-only. Confirms the exact current signature of
-- match_saves so the DROP FUNCTION below targets the right overload. If the args/
-- returns shown here differ from what this migration assumes (query_embedding
-- vector(768), match_user_id uuid, match_count integer), stop and adjust the
-- DROP FUNCTION line accordingly before running the rest of this file.
--
-- select p.proname,
--        pg_get_function_identity_arguments(p.oid) as args,
--        pg_get_function_result(p.oid) as returns
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'match_saves';

-- match_saves previously had no relevance floor at all: it always returned its full
-- match_count quota of "least-bad" neighbors by cosine distance, even when nothing in
-- a user's library was actually related to the query (e.g. searching "usdt" surfaced an
-- unrelated SEO tweet and a health article purely because they were the closest of a bad
-- bunch). It also didn't return a real similarity/distance column, so callers (/search,
-- /ask) had no numeric magnitude to rank or filter on — only rank position.
--
-- This migration adds a match_threshold parameter (rows below this cosine similarity are
-- excluded entirely, before match_count is applied) and makes the function's return
-- columns explicit and complete, including a real `similarity` column
-- (1 - cosine distance) and content_type/status (previously ambiguous whether these were
-- returned — recall_core.py's do_search relied on `.get(col, default)` fallbacks to mask
-- this; see CLAUDE.md Known Issue #33).
--
-- match_threshold defaults to 0.0 (no filtering) so any caller that doesn't pass it keeps
-- today's unfiltered behaviour — an instant rollback lever if needed.
--
-- content_type = 'article' and status = 'ready' are now also enforced in SQL (previously
-- only post-filtered in Python after the LIMIT was already applied). Behavior-neutral for
-- both existing callers (both already discard non-article/non-ready rows); it only
-- prevents a pending/media row from occupying one of the match_count slots that a real
-- candidate should get.

drop function if exists public.match_saves(vector(768), uuid, integer);

create function public.match_saves(
  query_embedding vector(768),
  match_user_id uuid,
  match_count integer,
  match_threshold float default 0.0
)
returns table (
  id uuid,
  url text,
  title text,
  content_text text,
  tag text,
  content_type text,
  status text,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    s.id,
    s.url,
    s.title,
    s.content_text,
    s.tag,
    s.content_type,
    s.status,
    s.created_at,
    1 - (s.embedding <=> query_embedding) as similarity
  from public.saves s
  where s.user_id = match_user_id
    and s.embedding is not null
    and s.content_type = 'article'
    and s.status = 'ready'
    and 1 - (s.embedding <=> query_embedding) >= match_threshold
  order by s.embedding <=> query_embedding asc
  limit match_count;
$$;

-- saves-adjacent functions created via SQL (not Table Editor) don't reliably keep their
-- default PUBLIC execute grant across a DROP+CREATE — grant explicitly, same rationale as
-- 008_grant_save_folders.sql / 009_grant_folders.sql.
grant execute on function public.match_saves(vector(768), uuid, integer, float) to anon;
grant execute on function public.match_saves(vector(768), uuid, integer, float) to authenticated;
grant execute on function public.match_saves(vector(768), uuid, integer, float) to service_role;
