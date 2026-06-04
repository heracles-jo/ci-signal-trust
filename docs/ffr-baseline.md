# FFR Baseline — CI Signal Trust

**Status:** BASELINE OF RECORD (organic, ≥2-week window). Supersedes all prior synthetic/interim versions.
**Issue:** HER-10 (parent HER-7). **Owner:** CTO.
**Published:** 2026-06-05. **Source repo:** `heracles-jo/heracles-gateway` (private, owned by us, organic CI traffic).

> **Bottom line:** Over **32 days** of real, organic CI history from `heracles-gateway`
> (2026-05-03 → 2026-06-04), the **pure-organic FFR is 11.90%** (25 flaky failures /
> 210 organic total failures) with **6.25 h estimated hours lost** to flakes. The
> classifier hard-gate **PASSES** (100% flake-verdict precision, 0 real defects leaked,
> labeled n=13). This satisfies HER-10's "≥2wk real data" acceptance criterion. Two
> organic jobs are recommended for quarantine. **No reduction claim attaches to this
> baseline** until an active quarantine intervention has run.

## Source & honesty notes

- **Source:** `heracles-jo/heracles-gateway`, a private repo owned by us, with 200
  workflow runs over 2026-05-03 → 2026-06-04 (~32 days). Organic CI traffic: nightly
  integration tests (DB matrix), perf regression (k6), PR build validation, security
  scans, and maintenance workflows. Not artificially seeded.
- **Job-level granularity:** The ingester found zero JUnit artifact uploads on this
  repo; it fell back to per-job granularity (one observation per workflow job, not per
  test case). FFR is therefore over *jobs*, not *test cases*. Stated transparently.
- **Fixture contamination:** our own `ci-signal-trust` fixture runs (9 failures on
  2026-06-04) are in the same Postgres DB and within this window. They contribute 3
  synthetic flaky failures and 6 synthetic real-defect failures to the raw totals. The
  organic-only numbers below exclude them; the mixed-pool numbers (from the unfiltered
  tool output) are noted for completeness.
- **Real-defect landscape:** `heracles-gateway` has several persistently-failing CI
  jobs (Nightly DB matrix × 4 databases, CodeQL, PR build, license inventory). The
  classifier correctly identifies these as real defects (100% failure rate) and does
  not count them as flakes. They are an engineering health concern but not part of
  the FFR.

## Window & sample size

| Field | Value |
|-------|-------|
| Source repo | `heracles-jo/heracles-gateway` (organic, private, owned by us) |
| Data window | 2026-05-03 21:04 UTC → 2026-06-04 21:39 UTC (**32 days**) |
| Window measured by tool | rolling `last 32 days` |
| CI runs ingested (heracles-gateway) | 189 (of 200; 11 cancelled/no-signal skipped) |
| Total DB rows (all sources) | 207 ci_runs · 780 test observations |
| Test observations in window | 219 total failures / 178 distinct test identities |
| Organic failures (excl. fixture) | **210** |
| Organic distinct failing identities | **11** |
| Organic flaky failures | **25** (2 distinct flaky jobs) |
| Fixture-seeded contamination | 3 flaky + 6 defect (ci-signal-trust fixture runs, 2026-06-04) |

## Result

### Primary: organic-only (heracles-gateway, fixture contamination excluded)

| Metric | Value |
|--------|-------|
| Total organic failures (32d window) | 210 |
| Organic flaky failures (32d window) | 25 |
| **FFR (organic)** | **11.90%** (25 / 210) |
| **Hours lost to flakes (organic, est.)** | **6.25 h** (25 × 0.25 h) |
| Annualized hours-lost (organic) | ~71 h/yr (6.25h / 32d × 365d) |
| Classifier gate | **PASS** — flake precision 100% ≥ bar 100%, 0 real defects leaked (n=13) |

### For reference: mixed pool (tool output, includes synthetic fixture contamination)

| Metric | Value |
|--------|-------|
| Total failures (32d window, all sources) | 219 |
| Flaky failures (32d window, all sources) | 28 |
| FFR (mixed) | 12.79% |
| Hours-lost (mixed, est.) | 7.00 h |

Tool output (`pnpm cli report --window-days 32 --json`, unfiltered):

```json
{
  "windowDays": 32,
  "totalFailures": 219,
  "flakyFailures": 28,
  "ffr": 0.1278538812785388,
  "reclaimedHoursEstimate": 7,
  "gate": {
    "bar": 1,
    "observedFlakePrecision": 1,
    "realDefectLeakCount": 0,
    "passed": true,
    "summary": "PASS: flake-verdict precision 100.00% >= bar 100%, 0 real defects leaked (labeled set n=13)."
  },
  "quarantineSuppressed": false,
  "quarantine": [
    {
      "testIdentity": "ci-signal-fixtures/flaky.fixture.ts ci-signal fixture: flaky workload > flaky: intermittent timing/race surrogate",
      "status": "recommended",
      "classification": "flake",
      "reason": "passed and failed on identical SHA 8f9d33ab4a5c66bcbab55825b614b397becda86c",
      "flakyCount": 3
    },
    {
      "testIdentity": "gha-job:Perf 회귀 테스트 (k6)/k6 5종 시나리오 회귀 검증",
      "status": "recommended",
      "classification": "flake",
      "reason": "passed and failed on identical SHA d9b2ed0f9a705fff68c5c85c3a2e38d8ca573fbf",
      "flakyCount": 3
    },
    {
      "testIdentity": "gha-job:오래된 이슈/PR 정리/stale 마킹·종료",
      "status": "recommended",
      "classification": "flake",
      "reason": "passed and failed on identical SHA d9b2ed0f9a705fff68c5c85c3a2e38d8ca573fbf",
      "flakyCount": 22
    }
  ]
}
```

## Organic quarantine candidates (2 real flakes found)

The fixture candidate (`ci-signal-fixtures/…`) is from our own synthetic harness and
should be excluded from any production quarantine action on `heracles-gateway`.

| Job identity | Flaky failures | % of runs | Classifier reason |
|-------------|---------------|-----------|-------------------|
| `gha-job:오래된 이슈/PR 정리/stale 마킹·종료`<br>(stale issue/PR cleanup) | **22** | 69% of 32 | Same-SHA pass+fail (SHA d9b2ed0f) |
| `gha-job:Perf 회귀 테스트 (k6)/k6 5종 시나리오 회귀 검증`<br>(k6 perf regression) | **3** | 60% of 5 | Same-SHA pass+fail (SHA d9b2ed0f) |

Both exhibit same-commit non-determinism (the core flake signal): the same source
revision sometimes passes and sometimes fails. The stale-cleanup job is by far the
dominant source of flake-noise (22/25 organic flaky failures = 88% of organic flake
budget).

## Method (transparent & reproducible)

**FFR definition** (rolling window `[now - windowDays, now]`):

```
FFR = (# failed observations whose job/test is classified `flake`) / (# failed observations total)
```

A failed observation counts as flaky when its identifier's classifier verdict over the
same window is `flake` (same-SHA pass+fail, or cross-SHA pass/fail flip-flop). See
`src/classifier.ts` and `src/reporting.ts`.

**Hours-lost heuristic** (stated transparently, intentionally conservative):

```
hours_lost = flaky_failures × 0.25 h   (HOURS_RECLAIMED_PER_FLAKY_FAILURE in src/reporting.ts)
```

Rationale: each flaky red build costs an engineer/agent ~15 minutes of triage before
the failure is recognized as noise. The 0.25 h factor is a placeholder to be tuned
against real triage timings.

**Reproduction:**

```bash
docker compose up -d db && pnpm db:migrate
GITHUB_TOKEN=$(gh auth token) pnpm ingest:github \
  --owner heracles-jo --repo heracles-gateway --max-runs 200
pnpm cli report --window-days 32 --json
```

Note: per-test JUnit granularity requires JUnit artifact uploads in the target repo.
`heracles-gateway` has none; job-level granularity is used (one observation per job).
FFR at test-case granularity may differ once JUnit uploads are enabled.

## Supersession history

| Date | Doc | Status | Notes |
|------|-----|--------|-------|
| 2026-06-04 | Initial zero-signal interim | Superseded | 0 failures, no signal |
| 2026-06-05 | Signal-bearing interim (synthetic fixtures) | Superseded | FFR 33.33%, controlled population |
| **2026-06-05** | **This doc — organic baseline** | **BASELINE OF RECORD** | FFR 11.90% organic, heracles-gateway, 32d |

## Appendix: heracles-gateway real-defect landscape

These jobs fail persistently (100% failure rate or near-100%) and are correctly
classified as **real defects**, not flakes. They are an engineering health concern
separate from the FFR:

| Job | Failures | Runs | Rate | Classification |
|-----|---------|------|------|----------------|
| Nightly DB matrix / mariadb | 32 | 32 | 100% | real defect |
| Nightly DB matrix / mysql | 32 | 32 | 100% | real defect |
| Nightly DB matrix / postgresql | 32 | 32 | 100% | real defect |
| Nightly DB matrix / oracle | 32 | 32 | 100% | real defect |
| CodeQL / java-kotlin | 24 | 24 | 100% | real defect |
| CodeQL / javascript-typescript | 24 | 24 | 100% | real defect |
| PR build + quality gate | 19 | 19 | 100% | real defect |
| License inventory update | 9 | 9 | 100% | real defect |

The DB matrix failures (4 databases × 32 nightly runs = 128 failures) are the single
largest failure population in `heracles-gateway`. They suggest a broken test
environment or a genuine multi-database regression that has not been addressed.
