# CI Signal Trust

A single-tenant, recommend-only **flaky-test detection** service. It ingests CI
run/test results over a signed webhook, stores run history in Postgres,
classifies each failing test as a **real defect** vs a **flake** with a pure
classifier, and exposes a **Flaky-Failure Rate (FFR)** report plus a
**quarantine candidate list** via a read API and a CLI.

v1 is single-tenant, one provider at a time, and **never mutates a repo** — it
only recommends.

## Architecture

```
                 (untrusted, HMAC-signed)
   CI provider ──────────POST /webhooks/ci──────────▶ Ingestion API (Fastify)
                                                          │  verify HMAC over raw body
                                                          │  validate (TypeBox, strict)
                                                          │  idempotent persist
                                                          ▼
                                                      Postgres
                                   commits ◀─ ci_runs ◀─ test_results
                                                          │
                       (read time, OFF the ack path)      │
   GET /reports/ffr  ─────────────────────────────────────┤
   CLI `report`      ─── recomputeQuarantine(db) ──────────┤  pure classifyTest()
                          computeFfr(db, windowDays) ──────┤
                                                          ▼
                                            FFR + quarantine report  ──▶ JSON / human
```

The classifier is a **pure function** (`src/classifier.ts`) with no I/O, so it is
exhaustively unit-testable. Classification happens at **read time** so the
webhook acknowledgement stays fast.

## Prerequisites

- Node.js 22 (ESM)
- pnpm 11+
- Docker (for local Postgres)

## Quick start (clean checkout)

```bash
pnpm install
cp .env.example .env            # then edit secrets if you like
docker compose up -d db         # start Postgres 16 (waits healthy)
pnpm db:migrate                 # apply migrations in ./drizzle
pnpm test                       # unit + real E2E against Postgres
pnpm dev                        # run the API with tsx watch (http://localhost:3000)
```

Tests read `DATABASE_URL` from the environment. The E2E suite skips itself if
`DATABASE_URL` is unset, so unit tests still run in CI without a database.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ci_signal_trust pnpm test:cov
```

## Sending a signed webhook

The ingestion endpoint authenticates with an HMAC-SHA256 over the **raw request
body**, in the header `x-signature-256: sha256=<hexdigest>`, keyed by
`INGEST_SIGNING_SECRET`. Example using `openssl` to compute the digest:

```bash
SECRET="local-dev-signing-secret"
BODY='{"provider":"github","externalRunId":"run-42","commitSha":"abc123","status":"failed","attempt":1,"startedAt":"2026-06-04T12:00:00Z","completedAt":"2026-06-04T12:03:00Z","tests":[{"identity":"suite.flakyTest","outcome":"failed","durationMs":120}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -sS -X POST http://localhost:3000/webhooks/ci \
  -H "content-type: application/json" \
  -H "x-signature-256: sha256=$SIG" \
  --data "$BODY"
# -> 202 {"status":"accepted","runId":"..."}
```

Responses:
- `202 {status:"accepted", runId}` — new run stored.
- `200 {status:"duplicate", runId}` — same `(provider, externalRunId)` already
  ingested; idempotent, no duplicate test rows inserted.
- `400` — body failed strict validation (clear message).
- `401` — missing/invalid signature.

## Reading the report

HTTP (bearer auth, deny-by-default, timing-safe compare):

```bash
curl -sS "http://localhost:3000/reports/ffr?windowDays=14" \
  -H "authorization: Bearer local-dev-read-token"
```

CLI (reuses the same reporting code):

```bash
pnpm cli report                 # human-readable
pnpm cli report --json          # JSON
pnpm cli report --window-days 30
```

## Classifier rules

`classifyTest(observations)` applies these in order and returns the **first**
match (`verdict ∈ { real_defect | flake | indeterminate }`):

1. **Same-SHA flake** — if for any single SHA the test has both a `passed` and a
   `failed` observation (incl. retry attempts), it is a `flake` ("identical code
   cannot deterministically both pass and fail").
2. **Cross-SHA flip-flop** — if across ≥2 distinct SHAs both pass and fail
   outcomes exist and the time-ordered sequence alternates at least once →
   `flake`.
3. **Real defect** — ≥1 failure and zero passes → `real_defect`.
4. **Indeterminate** — otherwise (e.g. no observations, or all passes).

## FFR definition

Over a rolling window `[now - windowDays, now]`:

```
FFR = (# failed test_results whose test is classified flake) / (# failed test_results total)
```

`reclaimedHoursEstimate = flakyFailures * 0.25h` — a transparent heuristic: each
flaky red build would otherwise cost ~15 minutes of engineer triage before being
recognized as noise. Tune `HOURS_RECLAIMED_PER_FLAKY_FAILURE` in
`src/reporting.ts` as real data accrues.

`recomputeQuarantine` materializes the `quarantine` table (UPSERT) — a test is
`recommended` when its verdict is `flake`, otherwise any prior recommendation is
`cleared`. Both operations are idempotent.

## Data model

| table          | purpose |
|----------------|---------|
| `commits`      | unique commit SHAs |
| `ci_runs`      | one CI run; **UNIQUE (provider, external_run_id)** for idempotency; `status ∈ {passed,failed}` |
| `test_results` | per-test outcome within a run; `outcome ∈ {passed,failed}`; indexed on `test_identity`, `run_id`, and `(test_identity, outcome)` |
| `quarantine`   | recommend-only output; PK `test_identity`; `status ∈ {recommended,cleared}` |

Migrations are generated by `drizzle-kit` into `./drizzle` and committed.

## Configuration (12-factor, env only)

| var                     | required | default | purpose |
|-------------------------|----------|---------|---------|
| `DATABASE_URL`          | yes      | —       | Postgres connection string |
| `INGEST_SIGNING_SECRET` | yes      | —       | HMAC key for `/webhooks/ci` |
| `READ_API_TOKEN`        | yes      | —       | Bearer token for `/reports/ffr` |
| `PORT`                  | no       | 3000    | HTTP port |
| `FFR_WINDOW_DAYS`       | no       | 14      | default FFR window |

Secrets are never hardcoded. `.env` is gitignored; `.env.example` has
placeholders only.

## Health

- `GET /healthz` — liveness, always 200.
- `GET /readyz` — checks DB via `SELECT 1`; 200 if reachable, else 503.

## Scripts

| script            | does |
|-------------------|------|
| `pnpm dev`        | `tsx watch src/server.ts` |
| `pnpm build`      | `tsc` to `dist/` |
| `pnpm start`      | `node dist/server.js` |
| `pnpm lint`       | `biome check .` |
| `pnpm format`     | `biome format --write .` |
| `pnpm test`       | `vitest run` |
| `pnpm test:cov`   | `vitest run --coverage` |
| `pnpm db:generate`| `drizzle-kit generate` |
| `pnpm db:migrate` | apply migrations |
| `pnpm cli ...`    | `tsx src/cli.ts` |

## Docker

Multi-stage `Dockerfile` builds a slim, non-root runtime image running
`node dist/server.js`. `docker-compose.yml` provides Postgres (`db`) plus an
optional `app` service under the `app` profile:

```bash
docker compose --profile app up --build
```
