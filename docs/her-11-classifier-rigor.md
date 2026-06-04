# HER-11 — Classifier rigor: labeled set + precision HARD GATE

**Parent:** HER-7 · **Gates:** HER-12 (quarantine recommend loop)

## What this delivers

1. A **labeled benchmark** of real-defect vs flake test histories, with **provenance for every label** — `src/eval/labeled-set.ts`.
2. A pure **evaluation harness** that measures classifier precision/recall against it — `src/eval/evaluation.ts`.
3. A **hard gate**: quarantine recommendations are **suppressed** whenever the classifier would leak a real defect into the flake verdict on the benchmark — wired into `recomputeQuarantine` in `src/reporting.ts`.

Run it yourself (no DB needed):

```
pnpm cli evaluate          # human-readable
pnpm cli evaluate --json   # machine-readable (includes the gate object)
```

## The bar (explicit, stated)

> **A real failure must NEVER be quarantined as a flake.**

Operationally this is the **precision of the `flake` verdict** measured against real-defect labels: of every test the classifier calls `flake`, what fraction are truly flakes. The rest, if any, are real defects we would have wrongly quarantined.

- **Bar:** `FLAKE_VERDICT_PRECISION_BAR = 1.0` (100%). Zero real defects may be classified as flake on the benchmark.
- The gate passes iff **real-defect leak count = 0** AND **flake-verdict precision ≥ bar**.
- This is a safety gate, not a tunable quality knob. Relaxing it means accepting that some real failures get silently quarantined — which the product forbids.

## Measured results

Labeled set size **n = 13** (real-run: 0, canonical: 13 — see "Provenance & honesty" below).

| Verdict | Precision | Recall |
| --- | --- | --- |
| `flake` | **100.00%** (7/7 predicted) | 100.00% (7/7 labeled) |
| `real_defect` | 100.00% (4/4 predicted) | 66.67% (4/6 labeled) |

**Hard gate:** bar 100% · observed flake precision **100.00%** · real defects leaked **0** · **result: PASS** ✅

The two real-defect cases not recovered as `real_defect` are the *introduced-regression* cases (`rd-introduced-regression`, `rd-introduced-regression-minimal`). The classifier conservatively returns `indeterminate` for them rather than `flake` — so they are **never quarantined** (the gate is satisfied) at the cost of real-defect recall. That trade — lower recall in exchange for zero false quarantine — is the correct realization of the hard gate.

## Classifier hardening this work drove

Building the benchmark surfaced a real leak in the original Rule 2 ("cross-SHA flip-flop"). It fired on a **single** monotonic transition, so a freshly-introduced regression — green on the parent commit, red on the child commit (`pass → fail`) — was classified as a flip-flop **flake** and would have been quarantined. That is exactly the failure the hard gate forbids.

**Fix:** Rule 2 now requires a **non-monotonic** sequence (≥ 2 time-ordered transitions, e.g. `pass → fail → pass`). A single monotonic transition is ambiguous (regression vs. fix) and falls through to `indeterminate` — never `flake`. Same-SHA contradiction (Rule 1) is unchanged and still the strongest flake signal.

## Provenance & honesty

Every labeled case declares its `source`:

- `real-run` — derived from a run actually ingested from our CI history; provenance cites the run id / SHA / PR.
- `canonical` — a hand-constructed history encoding a known CI failure mode; the label is true by construction and provenance states the mode and its real-world analog.

Our own CI history is still young: the only ingested runs at authoring time (GHA runs `26958164555` and `26958383895` on `heracles-jo/ci-signal-trust`) both **passed**, so they yield no labeled *failure* cases yet. The benchmark therefore starts fully `canonical`, covering each failure mode the classifier claims to handle plus the adversarial real-defect patterns the gate exists to protect. **As backfill (HER-9) surfaces real failures with adjudicated labels, append them as `source: 'real-run'` cases** — the metrics and gate recompute automatically, and the `evaluation.test.ts` suite keeps the gate honest in CI.

## How the gate protects the quarantine loop (HER-12)

`recomputeQuarantine` evaluates the live classifier against the benchmark before writing any recommendation. If the gate does not pass, **no test is recommended** and any existing recommendation is cleared with a suppression reason. The FFR report (`/reports/ffr` and `pnpm cli report`) surfaces `gate` and `quarantineSuppressed` so operators can see when recommendations are being withheld and why. If anyone later weakens the classifier and reintroduces a leak, the gate trips automatically and quarantine goes silent — fail-safe by construction.
