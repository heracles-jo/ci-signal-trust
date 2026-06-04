# FFR Baseline — CI Signal Trust

**Status:** Interim (zero-signal). Supersedes nothing; to be replaced by the matured 2-week baseline.
**Issue:** HER-10 (parent HER-7). **Owner:** CTO (interim).
**Published:** 2026-06-05.

> **Bottom line:** Over all CI history available from our own repo to date, there are
> **zero failures**, so the Flaky-Failure Rate (FFR) is **undefined / 0%** and
> estimated **hours lost to flakes is 0**. This is an honest *interim* baseline: it
> establishes the measurement pipeline and method, but it carries **no signal** —
> a 0-failure population cannot validate the metric and gives us nothing to measure
> a future reduction against. The meaningful baseline requires a failure population
> (see "Path to a meaningful baseline").

## Window & sample size

| Field | Value |
|-------|-------|
| Source repo | `heracles-jo/ci-signal-trust` (our own CI) |
| Data window | 2026-06-04 10:05 UTC → 2026-06-04 21:00 UTC (~11 hours of run history) |
| Window measured by tool | rolling `last 14 days` (captures all history; repo created 2026-06-04) |
| CI runs ingested | 6 |
| Test observations | 57 |
| Test failures (`outcome='failed'`) | **0** |
| Flaky failures | **0** |
| Quarantine candidates | 0 |

Sample is far below a literal 2-week window (which matures ~2026-06-18) **and**
contains no failures, so the denominator of FFR is zero.

## Result

| Metric | Value |
|--------|-------|
| Total failures (window) | 0 |
| Flaky failures (window) | 0 |
| **FFR** | **undefined (0 failures); reported as 0.00%** |
| **Hours lost to flakes (est.)** | **0.00 h** |

Tool output (`pnpm cli report --window-days 14 --json`):

```json
{ "windowDays": 14, "totalFailures": 0, "flakyFailures": 0, "ffr": 0, "reclaimedHoursEstimate": 0, "quarantine": [] }
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
pnpm ingest:github --owner heracles-jo --repo ci-signal-trust   # GITHUB_TOKEN optional for public repos
pnpm cli report --window-days 14 --json
```

> Data-fidelity caveat: this interim pull ran **unauthenticated**, so JUnit artifact
> downloads returned 401 and the ingester fell back to job-level granularity for the
> newest runs (per-test JUnit needs a read-only `GITHUB_TOKEN`). With zero failures
> present, this does not change the result, but the matured baseline should run with a
> token so per-test classification is exercised.

## Path to a meaningful baseline

A 0/0 baseline is honest but cannot anchor a reduction claim. Two ways forward:

1. **Mature in place (no new inputs).** Let our own CI accrue history to the literal
   2-week window (~2026-06-18) and re-publish. Risk: our CI may rarely fail, so even
   at maturity the failure population (and thus signal) could stay near zero.
2. **Point ingestion at a repo we own with ≥2 weeks of existing CI history and real
   failures.** This yields a signal-bearing baseline **now** instead of waiting, at
   the cost of choosing a repo that fairly represents "us." This is a strategy call
   (it defines what our FFR means and what reduction claims apply to) and needs a
   read-only `GITHUB_TOKEN` for the chosen repo.

**CTO recommendation:** pursue (2) if the CEO wants a signal-bearing baseline before
2026-06-18; otherwise (1) by default. Either way, **no reduction claim may be made
against this interim baseline.**
