/**
 * PURE JUnit XML parser. NO network, NO DB — unit-testable.
 *
 * Converts a JUnit report (the de-facto CI test-report format, emitted by Vitest,
 * pytest, Jest, surefire, etc.) into per-test observations. Handles the common
 * shape: <testsuites?> <testsuite>+ <testcase>+ where a <testcase> with a child
 * <failure> or <error> is a failure, <skipped> is excluded, otherwise a pass.
 *
 * Degrades gracefully: malformed or empty XML yields an empty result rather than
 * throwing, so a single bad artifact never aborts a whole ingest run.
 */

import { XMLParser } from 'fast-xml-parser';
import type { ObservationInput } from '../model.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Always materialize repeated children as arrays so a single testcase and many
  // testcases are handled by the same code path.
  isArray: (name) => name === 'testsuites' || name === 'testsuite' || name === 'testcase',
});

type RawAttrs = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) {
    return [];
  }
  return Array.isArray(v) ? v : [v];
}

function attr(node: RawAttrs, name: string): string | undefined {
  const v = node[`@_${name}`];
  return v === undefined || v === null ? undefined : String(v);
}

/** Build a stable test identity from classname + name (mirrors common CI tooling). */
function testIdentity(node: RawAttrs): string {
  const name = attr(node, 'name') ?? '';
  const classname = attr(node, 'classname');
  if (classname && name) {
    return `${classname} ${name}`;
  }
  return classname || name || 'unknown';
}

function durationMs(node: RawAttrs): number | null {
  const time = attr(node, 'time');
  if (time === undefined) {
    return null;
  }
  const seconds = Number.parseFloat(time);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.round(seconds * 1000);
}

/**
 * Parse JUnit XML into observations. A `<skipped>` testcase is omitted entirely
 * (no signal). Returns [] for unparseable or empty input.
 */
export function parseJUnit(xml: string): ObservationInput[] {
  if (!xml || xml.trim() === '') {
    return [];
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  // Root may be <testsuites> wrapping suites, or a bare <testsuite>.
  const suites: RawAttrs[] = [];
  for (const wrapper of asArray(doc.testsuites as RawAttrs | RawAttrs[] | undefined)) {
    suites.push(...asArray((wrapper as { testsuite?: RawAttrs | RawAttrs[] }).testsuite));
  }
  suites.push(...asArray(doc.testsuite as RawAttrs | RawAttrs[] | undefined));

  const out: ObservationInput[] = [];
  for (const suite of suites) {
    for (const tc of asArray((suite as { testcase?: RawAttrs | RawAttrs[] }).testcase)) {
      const node = tc as RawAttrs;
      if ('skipped' in node) {
        continue;
      }
      const failed = 'failure' in node || 'error' in node;
      out.push({
        identity: testIdentity(node),
        outcome: failed ? 'failed' : 'passed',
        durationMs: durationMs(node),
      });
    }
  }
  return out;
}
