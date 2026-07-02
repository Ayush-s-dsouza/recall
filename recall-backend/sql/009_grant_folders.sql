-- folders was created via SQL (not Table Editor), so the anon/authenticated
-- roles never got auto-granted SELECT. Without this:
-- (a) fetchFolders from the frontend Supabase client returns empty
-- (b) browseByFilter's nested join save_folders(folder_id, folders(id, name))
--     can't resolve folder names, so the folder filter finds nothing.
GRANT SELECT ON TABLE public.folders TO anon;
GRANT SELECT ON TABLE public.folders TO authenticated;
