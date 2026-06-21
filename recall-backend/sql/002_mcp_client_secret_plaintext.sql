-- Fixes mcp_oauth_clients.client_secret_hash: the mcp Python SDK's
-- ClientAuthenticator (mcp/server/auth/middleware/client_auth.py) compares the
-- client_secret presented at /token via hmac.compare_digest against the raw value
-- returned by get_client() — it requires the plaintext, not a hash, to do that
-- comparison. This is fine: the secret is a server-generated high-entropy random
-- value (not a user password), comparable to an API key, not the kind of credential
-- hash-then-compare protects against. Access/refresh tokens (mcp_tokens) still use
-- hash-only storage since those ARE the bearer credentials granting resource access
-- and are looked up far more frequently.
--
-- Run this once in the Supabase SQL editor, after 001_mcp_oauth.sql.

alter table mcp_oauth_clients add column if not exists client_secret text;
alter table mcp_oauth_clients drop column if exists client_secret_hash;
