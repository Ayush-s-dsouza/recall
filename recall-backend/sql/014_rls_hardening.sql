-- Defense-in-depth RLS hardening for tables that should only ever be touched by the
-- backend's service-role client, never directly by a client holding just the anon key. None
-- of these tables have a documented anon/authenticated grant in any migration file, but
-- enabling RLS + revoking any stray grant is a safe, idempotent no-op if already correctly
-- locked down, and closes the gap if a grant was ever applied out-of-band via the Supabase
-- dashboard and never captured in a migration.

alter table public.push_subscriptions enable row level security;
revoke select, insert, update, delete on table public.push_subscriptions from anon;
revoke select, insert, update, delete on table public.push_subscriptions from authenticated;

alter table public.mcp_oauth_clients enable row level security;
revoke select, insert, update, delete on table public.mcp_oauth_clients from anon;
revoke select, insert, update, delete on table public.mcp_oauth_clients from authenticated;

alter table public.mcp_auth_codes enable row level security;
revoke select, insert, update, delete on table public.mcp_auth_codes from anon;
revoke select, insert, update, delete on table public.mcp_auth_codes from authenticated;

alter table public.mcp_tokens enable row level security;
revoke select, insert, update, delete on table public.mcp_tokens from anon;
revoke select, insert, update, delete on table public.mcp_tokens from authenticated;

-- `saves` predates this migrations folder entirely — its RLS policy has never been captured
-- in version control. Re-affirm it explicitly rather than assume the live dashboard state
-- matches what CLAUDE.md documents — this is the single most load-bearing control in the
-- whole app (match_saves' safety and the frontend's 6 direct anon-key reads both depend on
-- it). Unlike the tables above, `saves` IS legitimately read directly by the frontend's
-- anon-key client (Today's Saves list) — do NOT revoke anon/authenticated grants here, only
-- ensure RLS correctly scopes every row to its owner. Matches the same "for all using (...)"
-- style already used for `folders` in 007_folders.sql.
alter table public.saves enable row level security;
drop policy if exists "saves: owner only" on public.saves;
create policy "saves: owner only" on public.saves for all
  using (user_id = auth.uid());
