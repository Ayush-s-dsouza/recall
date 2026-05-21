# ReCall — Staging & Deployment Workflow

## Branch structure

| Branch | Deploys to | URL |
|---|---|---|
| `main` | Production | https://recall-iota-six.vercel.app |
| `staging` | Staging | https://recall-git-staging-ayushsdsouza-1666s-projects.vercel.app |

## Day-to-day workflow

1. Make changes on the `staging` branch (or a feature branch, then merge into `staging`)
2. Push to GitHub — Vercel auto-deploys to the staging URL
3. Test the change on the staging URL
4. When verified, merge `staging` into `main` and push — Vercel auto-deploys to production

```
# Start from staging
git checkout staging
git pull origin staging

# Make your changes, then commit
git add <files>
git commit -m "feat: ..."
git push origin staging
# → auto-deploys to staging URL

# After testing, promote to prod
git checkout main
git merge staging
git push origin main
# → auto-deploys to recall-iota-six.vercel.app
```

## Environment variables

Both environments share the same Supabase and Railway backend. Only the PostHog environment tag differs.

| Variable | Production | Staging |
|---|---|---|
| `VITE_SUPABASE_URL` | same | same |
| `VITE_SUPABASE_ANON_KEY` | same | same |
| `VITE_BACKEND_URL` | Railway URL | Railway URL |
| `VITE_POSTHOG_KEY` | prod key | same key |
| `VITE_APP_ENV` | (not set → defaults to `"production"`) | `"staging"` |
| `VITE_SENTRY_DSN` | set | set |

`VITE_APP_ENV=staging` is set as a Preview-only env var in the Vercel dashboard, scoped to the `staging` branch.

## PostHog analytics isolation

Every PostHog event is tagged with `{ environment: "production" | "staging" }`.

In the PostHog dashboard, add a filter `environment = production` to all insights so staging test events are excluded from production dashboards. Staging events are still captured and visible when you remove the filter — useful for debugging.

## Vercel setup reference

See the Vercel project settings:
- **Staging URL:** `recall-git-staging-ayushsdsouza-1666s-projects.vercel.app` (auto-assigned stable branch alias)
- **Environment Variables → `VITE_APP_ENV`:** Preview environment only, value `staging`
