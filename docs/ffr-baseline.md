# FFR Baseline — CI Signal Trust

**Status:** Interim (signal-bearing, controlled population). To be replaced by the matured ≥2-week organic baseline.
**Issue:** HER-10 (parent HER-7). **Owner:** CTO (interim).
**Published:** 2026-06-05 (supersedes the 2026-06-04 zero-signal interim).

> **Bottom line:** Over all CI history available from our own repo to date, the
> measured **Flaky-Failure Rate (FFR) is 33.33%** (3 flaky failures of 9 total
> failures) and estimated **hours lost to flakes is 0.75 h** for the window. The
> classifier hard-gate **PASSES** (100% flake-verdict precision, 0 real defects
> leaked on the labeled set, n=13). This is an honest *interim* baseline on a
> **controlled fixture population**, not organic developer traffic — read the
> caveats below before treating 33.33% as "our" FFR. It validates the measurement
> pipeline end-to-end and now carries signal, but a representative baseline still
> requires organic failures over ≥2 weeks (matures ~2026-06-18).

## Honesty caveats (read first)

1. **The failure population is synthetic.** Both failing tests are deliberately
   planted fixtures run via a dedicated `CI Signal Fixture` workflow:
   - `ci-signal-fixtures/flaky.fixture.ts` — an *intentional* flake (intermittent
     timing/race surrogate): 3 failures across 6 runs, same-SHA pass+fail.
   - `ci-signal-fixtures/defect.fixture.ts` — an *intentional* real defect
     (deterministic persistent failure): 6 failures across 6 runs.
   These exist to exercise both classifier verdicts on demand. The resulting
   33.33% FFR therefore reflects the **designed mix of the fixtures**, not the
   organic flake rate of our engineering work. Do not generalize it.
2. **Tiny window, tiny denominator.** ~11.5 hours of history, 9 total failures
   across 2 distinct failing identities. Far below a literal 2-week window.
3. **No reduction claim may be made against this interim baseline.** Its value is
   (a) proving the pipeline computes FFR + hours-lost correctly end-to-end, and
   (b) establishing the method and units. A *reduction* claim requires the matured
   organic baseline.

## Window & sample size

| Field | Value |
|-------|-------|
| Source repo | `heracles-jo/ci-signal-trust` (our own CI) |
| Data window | 2026-06-04 10:05 UTC → 2026-06-04 21:39 UTC (~11.5 hours of run history) |
| Window measured by tool | rolling `last 14 days` (captures all history; repo created 2026-06-04) |
| CI runs ingested | 18 |
| Commits | 12 |
| Test observations | 471 |
| Distinct test identities | 118 |
| Test failures (`outcome='failed'`) | **9** |
| Distinct failing identities | 2 (both fixtures) |
| Flaky failures | **3** |
| Quarantine candidates | 1 (the flaky fixture) |

## Result

| Metric | Value |
|--------|-------|
| Total failures (window) | 9 |
| Flaky failures (window) | 3 |
| **FFR** | **33.33%** (3 / 9) |
| **Hours lost to flakes (est.)** | **0.75 h** (3 × 0.25 h) |
| Classifier gate | **PASS** — flake precision 100% ≥ bar 100%, 0 real defects leaked (labeled n=13) |

Tool output (`pnpm cli report --window-days 14 --json`):

```json
{
  "windowDays": 14,
  "totalFailures": 9,
  "flakyFailures": 3,
  "ffr": 0.3333333333333333,
  "reclaimedHoursEstimate": 0.75,
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
    }
  ]
}
```

## Method (transparent & reproducible)

**FFR definition** (rolling window `[now - windowDays, now]`):

```
FFR = (# failed test_results whose test is classified `flake`) / (# failed test_results total)
```

A failed `test_result` counts as flaky when its `test_identity`'s classifier verdict
over the same window is `flake` (same-SHA pass+fail, or cross-SHA pass/fail flip-flop).
See `src/classifier.ts` and `src/reporting.ts`.

**Hours-lost heuristic** (stated transparently, intentionally conservative):

```
hours_lost = flaky_failures × 0.25 h   (HOURS_RECLAIMED_PER_FLAKY_FAILURE in src/reporting.ts)
```

Rationale: each flaky red build costs an engineer/agent ~15 minutes of triage before
the failure is recognized as noise (open the run, scan logs, re-run, confirm green).
This is the time a working quarantine reclaims; for a baseline it is the time
*currently lost* to flakes. The 0.25 h factor is a placeholder to be tuned against
real triage timings as data accrues.

**Reproduction:**

```bash
docker compose up -d db && pnpm db:migrate
pnpm ingest:github --owner heracles-jo --repo ci-signal-trust   # GITHUB_TOKEN for per-test JUnit
pnpm cli report --window-days 14 --json
```

## Path to a meaningful (organic) baseline

This interim baseline is signal-bearing but synthetic. To anchor a reduction claim
we need an **organic** failure population. Two ways forward:

1. **Mature in place.** Let our own CI accrue organic history to the literal 2-week
   window (~2026-06-18) and re-publish. Risk: our CI may rarely fail organically, so
   even at maturity the organic failure population could stay near zero — in which
   case the fixtures remain the only signal and we should say so plainly.
2. **Point ingestion at a repo we own with ≥2 weeks of existing CI history and real
   failures.** Yields an organic, signal-bearing baseline **now** instead of waiting,
   at the cost of choosing a repo that fairly represents "us." This is a strategy call
   (it defines what our FFR means and what reduction claims apply to) and needs a
   read-only `GITHUB_TOKEN` for the chosen repo.

**CTO recommendation:** keep this signal-bearing interim baseline as the method
proof; pursue (2) if the CEO wants an *organic* baseline before 2026-06-18, otherwise
(1) by default. Either way, **no reduction claim may be made against this interim
baseline** — fixture-driven FFR is a pipeline check, not a measure of our flake rate.
