# D1 migrations

Cloudflare D1 migrations for the membership database. `wrangler.jsonc` points
`migrations_dir` here for both the development and the production environment.

## Conventions

- One file per change, named `NNNN_snake_case_description.sql` with a zero-padded
  sequence, for example `0001_create_applications.sql`.
- Migrations are append-only. Never edit a migration that has been applied to
  production; add a forward-fix migration instead.
- Every migration must be reviewable on its own and must state its rollback or
  forward-fix path in the pull request.
- Migrations contain schema and non-personal reference data only. Never commit
  member data, production exports or seed rows derived from real people.
- `0005_add_retention_state.sql` adds the PII-erasure marker, time-bounded
  legal/investigation hold and the index used by the daily production retention
  Cron. Change it only with a new forward migration after it reaches production.
- `0006_add_five_year_membership_term.sql` adds the canonical constrained
  membership term and migrates legacy `ANNUAL` rows to `FIVE_YEAR`. The old
  column remains only as a compatibility mirror so the parent table and its
  foreign-key children never need a destructive SQLite rebuild.

## Commands

```bash
# List and apply locally (uses the local D1 instance under .wrangler/)
npx wrangler d1 migrations list DB --env=""
npx wrangler d1 migrations apply DB --env="" --local

# Production is applied by the deployment workflow, not by hand.
npx wrangler d1 migrations list DB --env production --remote
```
