# Live deployment readiness

This check is read-only. It never applies a migration, creates a cleanup job,
deploys a service, or prints credentials.

An offline check is intentionally not sufficient to declare readiness:

```sh
node scripts/live-deployment-readiness.mjs
```

Immediately before an approved development connection test, query the
read-only schedule verification RPC and verify local ADC:

```sh
node scripts/live-deployment-readiness.mjs --probe-cleanup-schedule --probe-adc
```

The probe requires `LIVE_EXTERNAL_ENV=development`, exact
`GOOGLE_CLOUD_PROJECT` / `LIVE_ALLOWED_GCP_PROJECT` and `SUPABASE_URL` /
`LIVE_ALLOWED_SUPABASE_REF` pairs, plus the server-only `SUPABASE_SECRET_KEY`.
The legacy `SUPABASE_SERVICE_ROLE_KEY` is accepted only as a temporary fallback.
Failure is terminal for deployment readiness. Passing this check is evidence,
not permission to migrate, schedule, call paid audio APIs, or deploy.
Both probe flags are mandatory for a ready result. Unsigned local evidence is
not accepted because it cannot prove external state.
