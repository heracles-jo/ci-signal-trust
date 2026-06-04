/**
 * PURE JUnit-artifact decoding. NO network — operates on already-downloaded zip
 * bytes. GitHub Actions artifacts are zip archives; a test-report artifact holds
 * one or more JUnit XML files. We unzip in-memory, parse every *.xml entry, and
 * concatenate the observations. Degrades gracefully: a corrupt zip or non-XML
 * entries yield an empty result rather than throwing.
 */

import { unzipSync } from 'fflate';
import type { ObservationInput } from '../model.js';
import { parseJUnit } from './parse.js';

const textDecoder = new TextDecoder();

/** Decode a downloaded artifact zip into observations from its JUnit XML entries. */
export function observationsFromArtifactZip(zip: Uint8Array): ObservationInput[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    return [];
  }

  const out: ObservationInput[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.toLowerCase().endsWith('.xml')) {
      continue;
    }
    out.push(...parseJUnit(textDecoder.decode(bytes)));
  }
  return out;
}

/** Heuristic: artifact names we treat as JUnit test reports. */
export function isJUnitArtifactName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('junit') || n.includes('test-result') || n.includes('test-report');
}
