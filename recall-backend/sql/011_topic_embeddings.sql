-- Round 4 search fix (see CLAUDE.md Known Issue #36): round 3's query-time LLM relevance
-- filter (thinking-enabled Gemini call, 5-15s per search) is replaced by a precomputed
-- "topic embedding" — a short, concentrated topic/entity phrase extracted once at save time
-- (where latency is invisible — background enrichment, Known Issue #1b) and embedded
-- separately from the full content. Query time becomes pure vector math: compare the query
-- embedding against both the content embedding (existing) and this new topic embedding
-- (cleaner signal, better separation for broad queries in a topically homogeneous library)
-- — no generative LLM call anywhere in the /search request path.

alter table public.saves add column if not exists topics text;
alter table public.saves add column if not exists topic_embedding vector(768);

-- STEP 0 (read-only) — confirm match_saves' current signature before the DROP below, same
-- caution as 010_match_saves_threshold.sql. If this differs from
-- (vector(768), uuid, integer, float), stop and adjust the DROP FUNCTION line accordingly.
--
-- select pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'match_saves';

drop function if exists public.match_saves(vector(768), uuid, integer, float);

-- New optional 5th param, default null, so /ask's existing call (main.py, which never
-- passes it) is completely unaffected and keeps behaving exactly as before — same
-- backward-compatible convention 010_match_saves_threshold.sql established for
-- match_threshold. topic_similarity is 0.0 whenever either side of the comparison is null
-- (the param wasn't passed, or a row predates this backfill) rather than erroring.
create function public.match_saves(
  query_embedding vector(768),
  match_user_id uuid,
  match_count integer,
  match_threshold float default 0.0,
  topic_query_embedding vector(768) default null
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
  similarity float,
  topic_similarity float
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
    1 - (s.embedding <=> query_embedding) as similarity,
    case when topic_query_embedding is null or s.topic_embedding is null then 0.0
         else 1 - (s.topic_embedding <=> topic_query_embedding) end as topic_similarity
  from public.saves s
  where s.user_id = match_user_id
    and s.embedding is not null
    and s.content_type = 'article'
    and s.status = 'ready'
    and 1 - (s.embedding <=> query_embedding) >= match_threshold
  order by s.embedding <=> query_embedding asc
  limit match_count;
$$;

grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768)) to anon;
grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768)) to authenticated;
grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768)) to service_role;
