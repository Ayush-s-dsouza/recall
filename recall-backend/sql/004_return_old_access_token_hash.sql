-- mcp_exchange_refresh_token now also returns the OLD row's access_token_hash,
-- so the Python layer can evict that token's entry from its in-process TTL
-- cache immediately on rotation. Without this, a freshly-rotated-away access
-- token could still read as valid from the cache for up to its TTL (60s) after
-- the underlying row was revoked — found while running the Stage 1 local OAuth
-- flow test (rotation invalidation check).
--
-- Run this once in the Supabase SQL editor, after 001/002/003.
-- (Postgres rejects CREATE OR REPLACE when the output columns change shape —
-- the old 5-column version must be dropped first.)

drop function if exists mcp_exchange_refresh_token(text, text, text, timestamptz, timestamptz);

create or replace function mcp_exchange_refresh_token(
  p_old_refresh_token_hash text,
  p_new_access_token_hash text,
  p_new_refresh_token_hash text,
  p_access_token_expires_at timestamptz,
  p_refresh_token_expires_at timestamptz
) returns table (
  id uuid, client_id text, user_id uuid, scope text, theft_detected boolean, old_access_token_hash text
) language plpgsql as $$
declare
  v_old mcp_tokens%rowtype;
  v_new_id uuid;
begin
  select * into v_old from mcp_tokens t where t.refresh_token_hash = p_old_refresh_token_hash for update;

  if v_old.id is null then
    return; -- no matching token; caller treats as invalid_grant
  end if;

  if v_old.revoked then
    with recursive family as (
      select t.id from mcp_tokens t where t.id = v_old.id
      union
      select t2.id from mcp_tokens t2 join family f on t2.rotated_from = f.id
    )
    update mcp_tokens t set revoked = true where t.id in (select f.id from family f);
    return query select v_old.id, v_old.client_id, v_old.user_id, v_old.scope, true, v_old.access_token_hash;
    return;
  end if;

  update mcp_tokens t set revoked = true where t.id = v_old.id;

  insert into mcp_tokens (
    access_token_hash, refresh_token_hash, client_id, user_id, scope,
    access_token_expires_at, refresh_token_expires_at, rotated_from
  ) values (
    p_new_access_token_hash, p_new_refresh_token_hash, v_old.client_id, v_old.user_id, v_old.scope,
    p_access_token_expires_at, p_refresh_token_expires_at, v_old.id
  ) returning mcp_tokens.id into v_new_id;

  return query select v_new_id, v_old.client_id, v_old.user_id, v_old.scope, false, v_old.access_token_hash;
end;
$$;
