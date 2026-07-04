-- save_folders should never be queried directly by the frontend (it goes through the
-- backend's own /folders and /save/{id}/folders endpoints instead) — the anon/authenticated
-- SELECT grant added in 008_grant_save_folders.sql was unnecessary, and combined with no RLS
-- policy on this table, let anyone holding just the public anon key read every user's
-- save<->folder groupings with zero authentication via the raw Supabase REST API. Revoke the
-- grant and enable RLS with no permissive policy — the backend's service-role client bypasses
-- RLS regardless, so nothing legitimate is broken; only a direct anon/authenticated PostgREST
-- query against save_folders is blocked, which nothing in this app relies on.
revoke select on table public.save_folders from anon;
revoke select on table public.save_folders from authenticated;
alter table public.save_folders enable row level security;
