-- User-defined folders for curating saves. A save can belong to many folders or none.
-- Tags (saves.tag) remain in the DB for future Library/clustering use but are no longer surfaced in the UI.

create table folders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  name         text not null,
  created_at   timestamptz default now(),
  unique (user_id, name)
);
create index folders_user_id_idx on folders(user_id);

alter table folders enable row level security;
create policy "folders: owner only"
  on folders for all using (user_id = auth.uid());

-- Many-to-many join table. No RLS — only the backend (service role) touches this table.
-- ON DELETE CASCADE on both FKs means:
--   - deleting a save removes its save_folders rows automatically
--   - deleting a folder removes its save_folders rows automatically (saves themselves are unaffected)
create table save_folders (
  save_id    uuid not null references saves(id)   on delete cascade,
  folder_id  uuid not null references folders(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (save_id, folder_id)
);
create index save_folders_folder_id_idx on save_folders(folder_id);
create index save_folders_save_id_idx   on save_folders(save_id);
