-- Tracks per-user Composio-connected Notion accounts so fetch_notion() can cheaply check "is
-- this user connected" with an indexed local SELECT instead of a live Composio API round-trip
-- on every save. This is a non-authoritative cache, not a source of truth — the actual Composio
-- action call is what determines whether a fetch really succeeds; a stale 'active' row here
-- just means ReCall attempts the Composio path and falls through to the existing Jina-scrape
-- fallback if that call comes back empty.
-- Reddit is NOT tracked here — it's a single shared service-account connection, stored as
-- COMPOSIO_REDDIT_CONNECTED_ACCOUNT_ID (an env var), not a per-user row. A Gmail-newsletter
-- integration was evaluated and deliberately dropped before implementation (poll-based trigger,
-- not worth the live-inbox-OAuth trust cost for a marginal win over CloudMailin) — see
-- DECISION_LOG.md — so `toolkit` only ever holds 'notion' today, kept as a general column
-- rather than hardcoded since that's simply what the data models, not a hedge for Gmail's return.
-- No RLS-bypassing anon/authenticated grant should ever exist — only the backend (service
-- role) touches this table, same convention as push_subscriptions/mcp_tokens.
create table composio_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  toolkit text not null,                    -- 'notion'
  connected_account_id text not null,
  status text not null default 'active',    -- 'active' | 'revoked'
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, toolkit)
);
create index composio_connections_user_id_idx on composio_connections(user_id);

alter table public.composio_connections enable row level security;
revoke select, insert, update, delete on table public.composio_connections from anon;
revoke select, insert, update, delete on table public.composio_connections from authenticated;
