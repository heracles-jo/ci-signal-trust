/**
 * Pure flaky-test classifier. NO I/O, NO DB, NO Fastify — exhaustively unit-testable.
 *
 * Given the observation history of a single test identity, decide whether its
 * failures look like a real defect, a flake, or are indeterminate.
 */

export type Outcome = 'passed' | 'failed';

export type TestObservation = {
  sha: string;
  outcome: Outcome;
  attempt: number;
  /** ISO-8601 datetime string; used to order observations across SHAs. */
  completedAt: string;
};

export type Verdict = 'real_defect' | 'flake' | 'indeterminate';

export type Classification = {
  verdict: Verdict;
  reason: string;
};

/**
 * Classify a single test's observation history.
 *
 * Rules are applied in order; the FIRST match wins:
 *
 *  1. Same-SHA flake: if for ANY single SHA the test has both a 'failed' and a
 *     'passed' observation (failed-then-passed on identical code, including
 *     retry attempts), it is a flake — identical code cannot deterministically
 *     both pass and fail.
 *  2. Cross-SHA flip-flop: if across >=2 distinct SHAs the time-ordered sequence
 *     of outcomes is NON-MONOTONIC — i.e. it changes direction at least twice
 *     (pass->fail->pass or fail->pass->fail) — the test is genuinely unstable
 *     across commits -> flake.
 *
 *     A SINGLE monotonic transition (all-pass-then-all-fail, or the reverse) is
 *     deliberately NOT treated as a flake: it is indistinguishable from a real
 *     regression being introduced (pass->fail) or a real defect being fixed
 *     (fail->pass). Per the HER-11 hard gate, a real failure must NEVER be
 *     quarantined as a flake, so we resolve this ambiguity conservatively and
 *     let such histories fall through to rule 3/4 rather than calling them flaky.
 *  3. Pure real defect: at least one failure and zero passes -> real_defect.
 *  4. Otherwise -> indeterminate (e.g. no observations, all passes, or a single
 *     monotonic pass<->fail transition that is too ambiguous to quarantine).
 */
export function classifyTest(observations: TestObservation[]): Classification {
  if (observations.length === 0) {
    return { verdict: 'indeterminate', reason: 'no observations provided' };
  }

  // Rule 1: same-SHA pass AND fail.
  const sameShaFlakeSha = findSameShaFlake(observations);
  if (sameShaFlakeSha !== null) {
    return {
      verdict: 'flake',
      reason: `passed and failed on identical SHA ${sameShaFlakeSha}`,
    };
  }

  const distinctShas = new Set(observations.map((o) => o.sha));
  const hasPass = observations.some((o) => o.outcome === 'passed');
  const hasFail = observations.some((o) => o.outcome === 'failed');

  // Rule 2: cross-SHA flip-flop. Requires >=2 distinct SHAs, both outcomes
  // present, and a NON-MONOTONIC sequence (>=2 time-ordered transitions). A
  // single monotonic transition is treated as ambiguous (regression/fix), not
  // flaky — see the rule docstring and the HER-11 hard gate.
  if (
    distinctShas.size >= 2 &&
    hasPass &&
    hasFail &&
    countTimeOrderedTransitions(observations) >= 2
  ) {
    return { verdict: 'flake', reason: 'cross-SHA flip-flop' };
  }

  // Rule 3: only failures observed.
  if (hasFail && !hasPass) {
    return { verdict: 'real_defect', reason: 'only failures observed' };
  }

  // Rule 4: everything else is indeterminate.
  if (!hasFail) {
    return { verdict: 'indeterminate', reason: 'no failures observed' };
  }
  return {
    verdict: 'indeterminate',
    reason: 'mixed outcomes without same-SHA flake or cross-SHA alternation',
  };
}

/**
 * Return a SHA for which both a passed and a failed observation exist, or null.
 */
function findSameShaFlake(observations: TestObservation[]): string | null {
  const byShaOutcomes = new Map<string, Set<Outcome>>();
  for (const obs of observations) {
    const set = byShaOutcomes.get(obs.sha) ?? new Set<Outcome>();
    set.add(obs.outcome);
    byShaOutcomes.set(obs.sha, set);
  }
  for (const [sha, outcomes] of byShaOutcomes) {
    if (outcomes.has('passed') && outcomes.has('failed')) {
      return sha;
    }
  }
  return null;
}

/**
 * Count outcome transitions in the time-ordered observation sequence (ordered by
 * completedAt, then attempt as a stable tie-break). A "transition" is any point
 * where the outcome differs from the immediately preceding observation.
 *
 *   all-pass / all-fail            -> 0 transitions (stable)
 *   all-pass-then-all-fail (or rev)-> 1 transition  (monotonic: regression/fix)
 *   pass->fail->pass (and longer)  -> >=2 transitions (genuine flip-flop)
 */
function countTimeOrderedTransitions(observations: TestObservation[]): number {
  const ordered = [...observations].sort((a, b) => {
    const ta = Date.parse(a.completedAt);
    const tb = Date.parse(b.completedAt);
    if (ta !== tb) {
      return ta - tb;
    }
    return a.attempt - b.attempt;
  });
  let transitions = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]?.outcome !== ordered[i - 1]?.outcome) {
      transitions++;
    }
  }
  return transitions;
}
