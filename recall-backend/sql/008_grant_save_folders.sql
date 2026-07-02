-- save_folders was created via SQL (not Table Editor), so the anon/authenticated
-- roles never got auto-granted SELECT. Without this, frontend relational joins
-- on save_folders return empty arrays silently, breaking the folder filter.
GRANT SELECT ON TABLE public.save_folders TO anon;
GRANT SELECT ON TABLE public.save_folders TO authenticated;
