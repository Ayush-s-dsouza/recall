-- Search-identity fix, part 2 (see CLAUDE.md): part 1 (recall_core.py) made source-identity
-- signals (YouTube channel, subreddit, tweet author) land reliably in content_text/topics,
-- which gets topic_similarity to a healthy score for identity queries. But match_saves'
-- recall stage (the WHERE clause) only ever gated on raw content similarity vs
-- match_threshold — a save with strong topic_similarity but content similarity just under
-- the floor (confirmed directly: 0.5925 vs a 0.60 threshold, for a real "lenny" query
-- against a real save) was excluded from the candidate set entirely, before topic_similarity
-- ever got a chance to matter for ranking. This is the exact gap Known Issue #36 already
-- flagged and deliberately deferred ("using topic_similarity for recall too... is a larger
-- change than this round's scope") — this migration is that follow-through.
--
-- Two changes:
-- 1. The WHERE clause now recalls a row if EITHER content similarity clears match_threshold
--    OR topic_similarity clears the new topic_match_threshold parameter (default 1.0, i.e.
--    effectively never triggers unless explicitly passed — /ask's existing call, which never
--    passes topic_query_embedding at all, is completely unaffected).
-- 2. The ORDER BY now sorts by whichever distance (content or topic) is smaller, not content
--    distance alone — otherwise a topic-recalled row would still get silently cut off by
--    `limit match_count`, since a content-only ordering ranks it far below every save that
--    matched on content similarity, regardless of how well it matched on topic.
--
-- STEP 0 (read-only) — confirm match_saves' current signature before the DROP below, same
-- caution as prior migrations.
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
  topic_query_embedding vector(768) default null,
  topic_match_threshold float default 1.0
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
    and (
      1 - (s.embedding <=> query_embedding) >= match_threshold
      or (
        topic_query_embedding is not null
        and s.topic_embedding is not null
        and 1 - (s.topic_embedding <=> topic_query_embedding) >= topic_match_threshold
      )
    )
  order by least(
    s.embedding <=> query_embedding,
    case when topic_query_embedding is not null and s.topic_embedding is not null
         then s.topic_embedding <=> topic_query_embedding
         else 1.0 end
  ) asc
  limit match_count;
$$;

grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768), float) to anon;
grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768), float) to authenticated;
grant execute on function public.match_saves(vector(768), uuid, integer, float, vector(768), float) to service_role;
