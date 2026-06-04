import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  isJUnitArtifactName,
  observationsFromArtifactZip,
} from '../src/providers/junit/artifact.js';
import { parseJUnit } from '../src/providers/junit/parse.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseJUnit', () => {
  it('parses a real Vitest JUnit report (all passing) to passed observations', () => {
    const obs = parseJUnit(fixture('vitest-junit.xml'));
    expect(obs.length).toBe(14);
    expect(obs.every((o) => o.outcome === 'passed')).toBe(true);
    // classname + name identity, derived from the real report.
    expect(obs[0]?.identity).toContain('test/classifier.test.ts');
  });

  it('classifies failures, errors, and excludes skipped from a mixed report', () => {
    const obs = parseJUnit(fixture('junit-mixed.xml'));
    // 4 testcases, 1 skipped -> 3 observations.
    expect(obs).toHaveLength(3);
    const byOutcome = obs.reduce<Record<string, number>>((acc, o) => {
      acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
      return acc;
    }, {});
    expect(byOutcome.passed).toBe(1); // passes cleanly
    expect(byOutcome.failed).toBe(2); // failure + error
  });

  it('builds identity from classname + name', () => {
    const obs = parseJUnit(fixture('junit-mixed.xml'));
    expect(obs[0]?.identity).toBe('test/sample.test.ts suite > passes cleanly');
  });

  it('converts time seconds to integer milliseconds', () => {
    const obs = parseJUnit(fixture('junit-mixed.xml'));
    const passing = obs.find((o) => o.outcome === 'passed');
    expect(passing?.durationMs).toBe(250); // time="0.25"
  });

  it('handles a bare <testsuite> root (no <testsuites> wrapper)', () => {
    const xml = `<testsuite name="s" tests="1"><testcase classname="c" name="t" time="0.1"/></testsuite>`;
    const obs = parseJUnit(xml);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ identity: 'c t', outcome: 'passed', durationMs: 100 });
  });

  it('handles a single testcase (not wrapped in an array)', () => {
    const xml = `<testsuites><testsuite><testcase classname="c" name="only"><failure/></testcase></testsuite></testsuites>`;
    const obs = parseJUnit(xml);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.outcome).toBe('failed');
  });

  it('falls back to name when classname is absent', () => {
    const xml = `<testsuite><testcase name="lonely"/></testsuite>`;
    expect(parseJUnit(xml)[0]?.identity).toBe('lonely');
  });

  it('degrades gracefully on empty or malformed input', () => {
    expect(parseJUnit('')).toEqual([]);
    expect(parseJUnit('   ')).toEqual([]);
    expect(parseJUnit('<<<not xml>>>')).toEqual([]);
  });

  it('returns null duration when time attribute is absent or invalid', () => {
    const xml = `<testsuite><testcase classname="c" name="a"/><testcase classname="c" name="b" time="x"/></testsuite>`;
    const obs = parseJUnit(xml);
    expect(obs[0]?.durationMs).toBeNull();
    expect(obs[1]?.durationMs).toBeNull();
  });
});

describe('observationsFromArtifactZip', () => {
  it('unzips a JUnit artifact and parses its XML entries', () => {
    const xml = fixture('junit-mixed.xml');
    const zip = zipSync({ 'junit.xml': new TextEncoder().encode(xml) });
    const obs = observationsFromArtifactZip(zip);
    expect(obs).toHaveLength(3);
  });

  it('aggregates observations across multiple XML entries and ignores non-XML', () => {
    const zip = zipSync({
      'a/junit.xml': new TextEncoder().encode(fixture('junit-mixed.xml')),
      'b/results.xml': new TextEncoder().encode(fixture('vitest-junit.xml')),
      'readme.txt': new TextEncoder().encode('not xml'),
    });
    const obs = observationsFromArtifactZip(zip);
    expect(obs.length).toBe(3 + 14);
  });

  it('returns [] for a corrupt zip', () => {
    expect(observationsFromArtifactZip(new Uint8Array([1, 2, 3, 4]))).toEqual([]);
  });
});

describe('isJUnitArtifactName', () => {
  it.each(['junit', 'JUnit-report', 'test-results', 'test-report.zip'])('accepts %s', (n) => {
    expect(isJUnitArtifactName(n)).toBe(true);
  });

  it.each(['coverage', 'build-output', 'logs'])('rejects %s', (n) => {
    expect(isJUnitArtifactName(n)).toBe(false);
  });
});
