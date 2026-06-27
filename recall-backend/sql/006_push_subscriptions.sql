-- Web Push subscriptions, one row per device/browser a user has enabled
-- save-ready notifications on. No RLS — only the backend (service role) touches this table.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);
create index push_subscriptions_user_id_idx on push_subscriptions(user_id);
