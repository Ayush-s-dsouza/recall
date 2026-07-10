-- Video-support round (see CLAUDE.md): video/image saves now get real content extracted
-- at save time (YouTube transcripts, Instagram captions) instead of an empty content_text,
-- but they were still structurally excluded from search by match_saves' hardcoded
-- `content_type = 'article'` filter (010/011). This migration removes that filter — the
-- real gate stays `embedding is not null` (a save with no usable content still can't match)
-- and `status = 'ready'` (a still-enriching placeholder never surfaces).
--
-- Also adds `thumbnail_url`, populated for YouTube saves only (real, public CDN thumbnail
-- URLs) — Instagram/TikTok stay null, since Instagram's CDN blocks direct hotlinking
-- (confirmed directly: a GET of the embed page's own cover image returns 403 even with a
-- Referer header) and TikTok isn't given real content-extraction treatment this round.

alter table public.saves add column if not exists thumbnail_url text;

-- STEP 0 (read-only) — confirm match_saves' current signature before the DROP below, same
-- caution as 010/011.
--
-- select pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'match_saves';

drop function if exists public.match_saves(vector(768), uuid, integer, float, vector(768));

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
  thumbnail_url text,
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
    s.thumbnail_url,
    s.status,
    s.created_at,
    1 - (s.embedding <=> query_embedding) as similarity,
    case when topic_query_embedding is null or s.topic_embedding is null then 0.0
         else 1 - (s.topic_embedding <=> topic_query_embedding) end as topic_similarity
  from public.saves s
  where s.user_id = match_user_id
    and s.embedding is not null
    and s.status = 'ready'
    and 1 - (s.embedding <=> query_embedding) >= match_threshold
  order by s.embedding <=> query_embedding asc
  limit match_count;
$$;

grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768)) to anon;
grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768)) to authenticated;
grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768)) to service_role;
