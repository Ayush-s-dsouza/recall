# ReCall Feature Tour

1. Import with `import { FeatureTour, HelpMenuButton } from "./features/tour"`.
2. Render `<FeatureTour />` once near the authenticated app root.
3. Render `<HelpMenuButton />` in the header to replay the tour.
4. First-run behavior is controlled by `localStorage["recall.tour.completed"]`.
5. Use `resetTourCompletion()` to force the tour to open again in local testing.
6. Edit copy and videos in `tour-steps.js`.
7. Replace the placeholder public MP4 URLs with `/tour/import-x.mp4`, `/tour/search.mp4`, and `/tour/connect-llm.mp4` after adding files to `public/tour/`.
8. Videos autoplay muted, loop, and run at `0.6x` playback speed.
9. Optional Supabase sync is exposed as `syncToSupabase(userId, supabase)`.
10. No backend, schema, or dependency changes are required.
