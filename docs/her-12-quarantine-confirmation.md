# HER-12 — Quarantine recommend-with-confirmation loop

**Parent:** HER-7. **Depends on:** HER-10 (baseline), HER-11 (precision hard gate).

## What this delivers

A quarantine recommendation can never act on the codebase on its own. The loop is
**recommend → sign-off → action**, every step recorded in an append-only audit
trail, and the *only* mutation surface — the quarantine manifest CI consumes — is
built exclusively from tests that have been confirmed and then actioned by a
human/board.

## Lifecycle

```
                (classifier)              (human/board)        (human/board)
   absent ──► recommended ──► confirmed ──► actioned ──► [IN MANIFEST]
                  │  │
                  │  └────► rejected         (sticky human decision)
                  └───────► cleared          (classifier withdrew it)
```

- **classifier-owned:** `recommended`, `cleared`. Managed by the recompute path
  (`src/reporting.ts → applyRecommendation/clearRecommendation`).
- **human-owned:** `confirmed`, `actioned`, `rejected`. Once a human disposes of a
  recommendation, a background recompute **never** overwrites it — so an actioned
  quarantine is never silently un-applied, and a rejected one is never re-issued.

## The safety invariant (non-negotiable for v1)

> No repo/CI mutation without explicit sign-off; zero unconfirmed mutations.

Enforced **structurally**, not by convention:

1. The manifest (`buildQuarantineManifest`) selects only `status = 'actioned'`.
2. `actionQuarantine` refuses any source status other than `confirmed`
   (throws `QuarantineTransitionError`).
3. `confirmQuarantine` refuses any source status other than `recommended`.
4. `recommended` is only written when the **HER-11 hard gate passes** (flake-verdict
   precision ≥ bar; zero real defects leaked on the labeled benchmark).

Therefore a manifest entry is provably: gate-passed flake → human/board sign-off →
human action — each link captured in `quarantine_audit`.

## Surfaces

- **Schema:** `quarantine` gains `confirmed_at/by`, `actioned_at/by` and a widened
  status check; new append-only `quarantine_audit` table. Migration
  `drizzle/0001_quarantine_confirmation.sql`.
- **Service:** `src/quarantine.ts` (confirm/reject/action/manifest/audit/list).
- **CLI:** `cli quarantine <list|confirm|reject|action|manifest|audit>`.

## End-to-end proof

`docs/her-12-demo/transcript.txt` is a live run against Postgres showing:
recommendation issued (no mutation) → action-without-sign-off **refused** →
board confirm → action → manifest contains exactly one test → a second
recommended-but-unconfirmed flake stays out of the manifest → full audit trail.

Reproduce: `tsx scripts/her12-demo.ts seed` then the `cli quarantine` commands.
Covered by `test/quarantine.test.ts` (8 integration tests).
