import type {
  Rect,
  RendererTerminalRow,
  RendererTerminalSnapshot,
} from './contracts';

export interface TerminalRow extends RendererTerminalRow {
  /** Snapshot-local identity. It deliberately contains no terminal text. */
  key: string;
}

export interface TerminalSnapshot
  extends Omit<RendererTerminalSnapshot, 'rows'> {
  rows: TerminalRow[];
}

export type ReconciliationStatus = 'stable' | 'scrolled' | 'redrawn';

export interface RowReconciliation {
  status: ReconciliationStatus;
  /** new physical row index = old physical row index + offset. */
  offset: number | null;
  keyMappings: ReadonlyMap<string, string>;
  mappedAttachedKey: string | null;
  attachedExitedTop: boolean;
  holdMovedTooFast: boolean;
  targetChanged: boolean;
}

const MIN_SCROLL_MATCHES = 3;
const MIN_SCROLL_COVERAGE = 0.45;
const MIN_RUNNER_UP_GAP = 2;
const MAX_OFFSET_SPAN = 4096;
export const MAX_HOLD_SPEED_DIP_PER_SECOND = 750;
export const MAX_HOLD_DISPLACEMENT_ROW_HEIGHTS = 1.75;

export function createTerminalSnapshot(
  snapshot: RendererTerminalSnapshot,
): TerminalSnapshot {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row) => ({
      ...row,
      key: `${snapshot.targetId}:${row.index}:${row.signature}`,
    })),
  };
}

export function isPositiveFiniteRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/** Keeps blank rows in the snapshot while exposing only usable handholds. */
export function getAttachableRows(snapshot: TerminalSnapshot): TerminalRow[] {
  return snapshot.rows.filter(
    (row) => row.attachable && isPositiveFiniteRect(row.rect),
  );
}

interface OffsetScore {
  offset: number;
  exactMatches: number;
  context: number;
  evidence: number;
}

function rowMap(snapshot: TerminalSnapshot): Map<number, TerminalRow> {
  return new Map(snapshot.rows.map((row) => [row.index, row]));
}

function signatureCounts(rows: readonly TerminalRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.attachable) {
      counts.set(row.signature, (counts.get(row.signature) ?? 0) + 1);
    }
  }
  return counts;
}

function neighborAgreement(
  oldRows: ReadonlyMap<number, TerminalRow>,
  newRows: ReadonlyMap<number, TerminalRow>,
  oldIndex: number,
  newIndex: number,
): number {
  let agreements = 0;
  for (const direction of [-1, 1] as const) {
    const oldNeighbor = oldRows.get(oldIndex + direction);
    const newNeighbor = newRows.get(newIndex + direction);
    if (oldNeighbor && newNeighbor && oldNeighbor.signature === newNeighbor.signature) {
      agreements += 1;
    }
  }
  return agreements;
}

function scoreOffset(
  offset: number,
  oldRows: ReadonlyMap<number, TerminalRow>,
  newRows: ReadonlyMap<number, TerminalRow>,
  oldCounts: ReadonlyMap<string, number>,
  newCounts: ReadonlyMap<string, number>,
): OffsetScore {
  let exactMatches = 0;
  let context = 0;

  for (const oldRow of oldRows.values()) {
    if (!oldRow.attachable) continue;
    const newRow = newRows.get(oldRow.index + offset);
    if (!newRow?.attachable || newRow.signature !== oldRow.signature) continue;

    const agreement = neighborAgreement(
      oldRows,
      newRows,
      oldRow.index,
      newRow.index,
    );
    const duplicated =
      (oldCounts.get(oldRow.signature) ?? 0) > 1 ||
      (newCounts.get(oldRow.signature) ?? 0) > 1;

    // Repeated text is evidence only when its local physical context agrees.
    if (duplicated && agreement === 0) continue;
    exactMatches += 1;
    context += agreement;
  }

  return {
    offset,
    exactMatches,
    context,
    evidence: exactMatches + context,
  };
}

function compareScores(a: OffsetScore, b: OffsetScore): number {
  return (
    b.evidence - a.evidence ||
    b.exactMatches - a.exactMatches ||
    b.context - a.context ||
    Math.abs(a.offset) - Math.abs(b.offset) ||
    a.offset - b.offset
  );
}

function acceptedMappings(
  previous: TerminalSnapshot,
  current: TerminalSnapshot,
  offset: number,
): Map<string, string> {
  const nextByIndex = rowMap(current);
  const oldByIndex = rowMap(previous);
  const oldCounts = signatureCounts(previous.rows);
  const newCounts = signatureCounts(current.rows);
  const mappings = new Map<string, string>();

  for (const oldRow of previous.rows) {
    const nextRow = nextByIndex.get(oldRow.index + offset);
    if (!nextRow || nextRow.signature !== oldRow.signature) continue;

    if (oldRow.attachable || nextRow.attachable) {
      if (!oldRow.attachable || !nextRow.attachable) continue;
      const duplicated =
        (oldCounts.get(oldRow.signature) ?? 0) > 1 ||
        (newCounts.get(oldRow.signature) ?? 0) > 1;
      if (
        duplicated &&
        neighborAgreement(oldByIndex, nextByIndex, oldRow.index, nextRow.index) ===
          0
      ) {
        continue;
      }
    }
    mappings.set(oldRow.key, nextRow.key);
  }

  return mappings;
}

function attachmentFallback(
  previous: TerminalSnapshot,
  current: TerminalSnapshot,
  attachedKey: string | null,
): Map<string, string> {
  const mappings = new Map<string, string>();
  if (!attachedKey) return mappings;

  const oldRow = previous.rows.find((row) => row.key === attachedKey);
  if (!oldRow?.attachable) return mappings;

  const oldCounts = signatureCounts(previous.rows);
  const newCounts = signatureCounts(current.rows);
  if (
    oldCounts.get(oldRow.signature) !== 1 ||
    newCounts.get(oldRow.signature) !== 1
  ) {
    return mappings;
  }

  const nextRow = current.rows.find(
    (row) => row.attachable && row.signature === oldRow.signature,
  );
  if (!nextRow) return mappings;

  const oldByIndex = rowMap(previous);
  const nextByIndex = rowMap(current);
  if (
    neighborAgreement(oldByIndex, nextByIndex, oldRow.index, nextRow.index) < 1
  ) {
    return mappings;
  }

  mappings.set(oldRow.key, nextRow.key);
  return mappings;
}

function attachmentMovedTooFast(
  previous: TerminalSnapshot,
  current: TerminalSnapshot,
  oldKey: string,
  newKey: string,
): boolean {
  const oldRow = previous.rows.find((row) => row.key === oldKey);
  const newRow = current.rows.find((row) => row.key === newKey);
  if (!oldRow || !newRow) return false;

  const oldX = oldRow.rect.x + oldRow.rect.width / 2;
  const oldY = oldRow.rect.y + oldRow.rect.height / 2;
  const newX = newRow.rect.x + newRow.rect.width / 2;
  const newY = newRow.rect.y + newRow.rect.height / 2;
  const displacement = Math.hypot(newX - oldX, newY - oldY);
  const rowHeight = Math.max(1, (oldRow.rect.height + newRow.rect.height) / 2);
  if (displacement > MAX_HOLD_DISPLACEMENT_ROW_HEIGHTS * rowHeight) {
    return true;
  }

  const elapsedSeconds = (current.sampledAt - previous.sampledAt) / 1000;
  return (
    elapsedSeconds > 0 &&
    displacement / elapsedSeconds > MAX_HOLD_SPEED_DIP_PER_SECOND
  );
}

export function reconcileRows(
  previous: TerminalSnapshot | null,
  current: TerminalSnapshot,
  attachedKey: string | null = null,
): RowReconciliation {
  if (!previous) {
    return {
      status: 'redrawn',
      offset: null,
      keyMappings: new Map(),
      mappedAttachedKey: null,
      attachedExitedTop: false,
      holdMovedTooFast: false,
      targetChanged: false,
    };
  }

  if (previous.targetId !== current.targetId) {
    return {
      status: 'redrawn',
      offset: null,
      keyMappings: new Map(),
      mappedAttachedKey: null,
      attachedExitedTop: false,
      holdMovedTooFast: false,
      targetChanged: true,
    };
  }

  const oldByIndex = rowMap(previous);
  const nextByIndex = rowMap(current);
  const oldCounts = signatureCounts(previous.rows);
  const newCounts = signatureCounts(current.rows);
  const oldNonblank = previous.rows.reduce(
    (count, row) => count + Number(row.attachable),
    0,
  );
  const newNonblank = current.rows.reduce(
    (count, row) => count + Number(row.attachable),
    0,
  );

  const oldIndices = previous.rows.map((row) => row.index);
  const nextIndices = current.rows.map((row) => row.index);
  const oldMin = oldIndices.length ? Math.min(...oldIndices) : 0;
  const oldMax = oldIndices.length ? Math.max(...oldIndices) : 0;
  const nextMin = nextIndices.length ? Math.min(...nextIndices) : 0;
  const nextMax = nextIndices.length ? Math.max(...nextIndices) : 0;
  const minimumOffset = Math.max(-MAX_OFFSET_SPAN, nextMin - oldMax);
  const maximumOffset = Math.min(MAX_OFFSET_SPAN, nextMax - oldMin);
  const scores: OffsetScore[] = [];

  for (let offset = minimumOffset; offset <= maximumOffset; offset += 1) {
    scores.push(
      scoreOffset(offset, oldByIndex, nextByIndex, oldCounts, newCounts),
    );
  }
  scores.sort(compareScores);

  const emptyScore: OffsetScore = {
    offset: 0,
    exactMatches: 0,
    context: 0,
    evidence: 0,
  };
  const winner = scores[0] ?? emptyScore;
  const runnerUp = scores[1] ?? emptyScore;
  const smallerNonblankCount = Math.min(oldNonblank, newNonblank);
  const coverage =
    smallerNonblankCount > 0 ? winner.exactMatches / smallerNonblankCount : 0;
  const accepted =
    winner.evidence >= MIN_SCROLL_MATCHES &&
    coverage >= MIN_SCROLL_COVERAGE &&
    winner.evidence - runnerUp.evidence >= MIN_RUNNER_UP_GAP;

  let mappings = accepted
    ? acceptedMappings(previous, current, winner.offset)
    : attachmentFallback(previous, current, attachedKey);
  const offset = accepted ? winner.offset : null;
  const oldAttachedRow = attachedKey
    ? previous.rows.find((row) => row.key === attachedKey)
    : undefined;
  const attachedExitedTop = Boolean(
    accepted &&
      winner.offset < 0 &&
      oldAttachedRow &&
      oldAttachedRow.index + winner.offset < 0,
  );

  // A top exit intentionally has no destination mapping.
  if (attachedExitedTop && attachedKey) {
    mappings = new Map(mappings);
    mappings.delete(attachedKey);
  }
  const mappedAttachedKey = attachedKey
    ? (mappings.get(attachedKey) ?? null)
    : null;
  const holdMovedTooFast = Boolean(
    !attachedExitedTop &&
      attachedKey &&
      mappedAttachedKey &&
      attachmentMovedTooFast(
        previous,
        current,
        attachedKey,
        mappedAttachedKey,
      ),
  );

  return {
    status: accepted
      ? winner.offset === 0
        ? 'stable'
        : 'scrolled'
      : 'redrawn',
    offset,
    keyMappings: mappings,
    mappedAttachedKey,
    attachedExitedTop,
    holdMovedTooFast,
    targetChanged: false,
  };
}
