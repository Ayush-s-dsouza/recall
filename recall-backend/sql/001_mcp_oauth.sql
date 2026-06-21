-- Remote MCP server OAuth 2.1 schema (Claude/ChatGPT connectors).
-- Run this once in the Supabase SQL editor before deploying mcp_server.py.
-- See CLAUDE.md "Supabase Schema" section for the documented version of this.

create table if not exists mcp_oauth_clients (
  client_id text primary key,
  client_secret_hash text,                 -- null for public PKCE-only clients
  client_name text,
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code','refresh_token'],
  token_endpoint_auth_method text not null default 'client_secret_post',
  registered_from_ip text,                  -- abuse investigation only, not enforced
  created_at timestamptz not null default now()
);

create table if not exists mcp_auth_codes (
  code text primary key,
  client_id text not null references mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null,
  redirect_uri text not null,
  redirect_uri_provided_explicitly boolean not null default true,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scope text,
  resource text,
  expires_at timestamptz not null,          -- created_at + 5 min
  used boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists mcp_auth_codes_expires_at_idx on mcp_auth_codes (expires_at);

create table if not exists mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token_hash text not null unique,
  refresh_token_hash text unique,
  client_id text not null references mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null,
  scope text,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  rotated_from uuid references mcp_tokens(id)   -- traces rotation lineage, enables theft detection
);
create index if not exists mcp_tokens_user_id_idx on mcp_tokens (user_id);
create index if not exists mcp_tokens_access_token_hash_idx on mcp_tokens (access_token_hash);
create index if not exists mcp_tokens_refresh_token_hash_idx on mcp_tokens (refresh_token_hash);

-- Atomically rotates a refresh token: locks the old row, revokes it, inserts the new
-- pair, and links them via rotated_from. If the old refresh token was *already*
-- revoked (i.e. it's being reused after a prior rotation — a theft signal), revokes
-- the entire token family reachable via the rotated_from chain instead of issuing a
-- new token, and reports theft_detected = true so the caller can force re-auth.
--
-- This is the server-side analogue of the bug fixed in the local recall-mcp stdio
-- server: rotation must be a single atomic write, with no window where a crash could
-- either double-rotate or silently lose the new token.
create or replace function mcp_exchange_refresh_token(
  p_old_refresh_token_hash text,
  p_new_access_token_hash text,
  p_new_refresh_token_hash text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz
) returns table (
  id uuid, client_id text, user_id uuid, scope text, theft_detected boolean
) language plpgsql as $$
declare
  v_old mcp_tokens%rowtype;
  v_new_id uuid;
begin
  select * into v_old from mcp_tokens where refresh_token_hash = p_old_refresh_token_hash for update;

  if v_old.id is null then
    return; -- no matching token; caller treats as invalid_grant
  end if;

  if v_old.revoked then
    with recursive family as (
      select id from mcp_tokens where id = v_old.id
      union
      select t.id from mcp_tokens t join family f on t.rotated_from = f.id
    )
    update mcp_tokens set revoked = true where id in (select id from family);
    return query select v_old.id, v_old.client_id, v_old.user_id, v_old.scope, true;
    return;
  end if;

  update mcp_tokens set revoked = true where id = v_old.id;

  insert into mcp_tokens (
    access_token_hash, refresh_token_hash, client_id, user_id, scope,
    access_token_expires_at, refresh_token_expires_at, rotated_from
  ) values (
    p_new_access_token_hash, p_new_refresh_token_hash, v_old.client_id, v_old.user_id, v_old.scope,
    p_access_token_expires_at, p_refresh_token_expires_at, v_old.id
  ) returning id into v_new_id;

  return query select v_new_id, v_old.client_id, v_old.user_id, v_old.scope, false;
end;
$$;
