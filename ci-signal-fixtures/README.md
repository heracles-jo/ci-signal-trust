# CI Signal Fixtures (HER-10)

**These tests are intentionally flaky / failing. Do not "fix" them.**

## Why this exists

CI Signal Trust dogfoods itself: we ingest our *own* GitHub Actions history to
publish a Flaky-Failure Rate (FFR) baseline. But our real test suite is green, so
on its own it produces **zero failures** — a 0/0 baseline with no signal (see
`docs/ffr-baseline.md`).

To get a meaningful baseline before the ~2026-06-18 maturity window, this workload
generates a **realistic CI-signal population** on our own repo:

| Fixture | Behavior | Classifier verdict | Role in FFR |
|---------|----------|--------------------|-------------|
| `flaky.fixture.ts` | one test flips pass/fail (~40% fail) on the same SHA | `flake` | numerator (flaky failures) |
| `defect.fixture.ts` | one test always fails | `real_defect` | denominator only (non-flake failure) |

Together they make `total_failed > 0` with a flake fraction `< 100%`, so the matured
FFR is a real, signal-bearing number instead of a zero floor.

## How it is isolated (does NOT gate merges)

- Run only by the **`CI Signal Fixture`** workflow (`.github/workflows/ci-signal-fixture.yml`)
  on a `schedule` + `workflow_dispatch` — **never** on `pull_request`. It is not a
  required status check.
- Excluded from the gating `ci` suite: `vitest.config.ts` includes only `test/**`,
  while these live in `ci-signal-fixtures/**/*.fixture.ts` and run via
  `vitest.fixtures.config.ts`.
- Split into two jobs (`flaky-signal`, `defect-signal`) so the signal survives even
  at job-level ingestion granularity; both also upload JUnit (`junit-fixture-*`) for
  per-test granularity.

## How the signal is consumed

The daily ingest (`.github/workflows/ingest.yml`) pulls these runs (and their JUnit
artifacts) into Postgres. `pnpm cli report` then computes FFR over the rolling window.

## Removal

Once a genuine organic failure/flake population exists (real defects + real flakes in
the product suite), this fixture workload can be retired. Until then it is the honest
mechanism for a non-empty baseline denominator.
