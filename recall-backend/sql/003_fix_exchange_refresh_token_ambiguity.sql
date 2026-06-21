-- Fixes "column reference \"id\" is ambiguous" in mcp_exchange_refresh_token.
-- The function's RETURNS TABLE columns (id, client_id, user_id, scope) share
-- names with mcp_tokens' own columns, so every bare reference to those names
-- inside the function body was ambiguous between the implicit OUT-parameter
-- variable and the table column. Fixed by qualifying every column reference
-- with an explicit table alias. Found while running the Stage 1 local OAuth
-- flow test (refresh-token rotation step).
--
-- Run this once in the Supabase SQL editor, after 001/002.

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
    return query select v_old.id, v_old.client_id, v_old.user_id, v_old.scope, true;
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

  return query select v_new_id, v_old.client_id, v_old.user_id, v_old.scope, false;
end;
$$;
