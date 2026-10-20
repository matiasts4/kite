import committedFailures from './failures.json';
import utterances from './utterances.es.json';

export type ZedFailureLayer = 'oir' | 'entender' | 'hacer';
export type ZedFailureStatus = 'open' | 'encoded';

export interface ZedFailureRow {
  id: string;
  recordedAt: string;
  layer: ZedFailureLayer;
  phrase: string;
  expected: string;
  trace?: string;
  status: ZedFailureStatus;
  heard?: string;
  said?: string;
  observed?: string;
}

const LAYERS = new Set<ZedFailureLayer>(['oir', 'entender', 'hacer']);
const STATUSES = new Set<ZedFailureStatus>(['open', 'encoded']);
const KEBAB_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string, prefix: string): string | null {
  if (typeof value !== 'string') {
    return `${prefix}: "${field}" must be a string`;
  }
  if (value.trim().length === 0) {
    return `${prefix}: "${field}" must not be empty`;
  }
  return null;
}

export function normalizeFailureRows(raw: unknown): ZedFailureRow[] {
  if (!Array.isArray(raw)) {
    throw new Error('Zed failures registry must be a JSON array');
  }
  return raw as ZedFailureRow[];
}

export function getUtteranceInputs(): string[] {
  return utterances.map((row) => row.input);
}

export function loadCommittedFailures(): ZedFailureRow[] {
  return normalizeFailureRows(committedFailures);
}

/**
 * Pure validation: returns human-readable problems (empty = registry OK).
 */
export function collectFailureProblems(
  rows: ZedFailureRow[],
  utteranceInputs: Iterable<string>
): string[] {
  const inputSet = new Set(Array.from(utteranceInputs, (s) => s.trim()));
  const problems: string[] = [];
  const seenIds = new Map<string, number>();

  rows.forEach((row, index) => {
    const prefix = `failures[${index}]`;

    if (!isRecord(row)) {
      problems.push(`${prefix}: row must be an object`);
      return;
    }

    const id = row.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      problems.push(`${prefix}: "id" must be a non-empty string`);
    } else if (!KEBAB_ID.test(id)) {
      problems.push(`${prefix}: id "${id}" must be kebab-case`);
    } else if (seenIds.has(id)) {
      problems.push(
        `${prefix}: duplicate id "${id}" (first at index ${seenIds.get(id)})`
      );
    } else {
      seenIds.set(id, index);
    }

    const recordedAt = row.recordedAt;
    if (typeof recordedAt !== 'string' || !ISO_DATE.test(recordedAt)) {
      problems.push(`${prefix}: "recordedAt" must be YYYY-MM-DD`);
    }

    const layer = row.layer;
    if (typeof layer !== 'string' || !LAYERS.has(layer as ZedFailureLayer)) {
      problems.push(`${prefix}: invalid layer "${String(layer)}"`);
    }

    const phraseProblem = nonEmptyString(row.phrase, 'phrase', prefix);
    if (phraseProblem) problems.push(phraseProblem);

    const expectedProblem = nonEmptyString(row.expected, 'expected', prefix);
    if (expectedProblem) problems.push(expectedProblem);

    const status = row.status;
    if (typeof status !== 'string' || !STATUSES.has(status as ZedFailureStatus)) {
      problems.push(`${prefix}: invalid status "${String(status)}"`);
      return;
    }

    const phrase = typeof row.phrase === 'string' ? row.phrase.trim() : '';
    const expected = typeof row.expected === 'string' ? row.expected.trim() : '';
    const rowId = typeof id === 'string' ? id : String(index);

    if (status === 'open') {
      problems.push(
        `Zed failure "${rowId}" is still open (${layer}): phrase="${phrase}" expected="${expected}"`
      );
      return;
    }

    if (layer === 'entender') {
      if (!inputSet.has(phrase)) {
        problems.push(
          `${prefix}: encoded entender failure "${rowId}" phrase is not in utterances.es.json inputs`
        );
      }
      return;
    }

    if (layer === 'oir') {
      const heardProblem = nonEmptyString(row.heard, 'heard', prefix);
      if (heardProblem) problems.push(heardProblem);
      const saidProblem = nonEmptyString(row.said, 'said', prefix);
      if (saidProblem) problems.push(saidProblem);
      const traceProblem = nonEmptyString(row.trace, 'trace', prefix);
      if (traceProblem) problems.push(traceProblem);

      const heard = typeof row.heard === 'string' ? row.heard.trim() : '';
      const said = typeof row.said === 'string' ? row.said.trim() : '';
      if (heard && said && heard === said) {
        problems.push(
          `${prefix}: oir failure "${rowId}" heard and said must differ`
        );
      }
      if (phrase && heard && phrase !== heard) {
        problems.push(
          `${prefix}: oir failure "${rowId}" phrase must equal heard`
        );
      }
      return;
    }

    if (layer === 'hacer') {
      const traceProblem = nonEmptyString(row.trace, 'trace', prefix);
      if (traceProblem) problems.push(traceProblem);
      const observedProblem = nonEmptyString(row.observed, 'observed', prefix);
      if (observedProblem) problems.push(observedProblem);
    }
  });

  return problems;
}

export function assertFailuresRegistryValid(
  rows: ZedFailureRow[],
  utteranceInputs: Iterable<string> = getUtteranceInputs()
): void {
  const problems = collectFailureProblems(rows, utteranceInputs);
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

export function validateCommittedFailures(): void {
  assertFailuresRegistryValid(loadCommittedFailures());
}
