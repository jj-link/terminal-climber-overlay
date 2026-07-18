import { describe, expect, it } from 'vitest';
import type { RendererTerminalSnapshot } from '../src/contracts';
import {
  createTerminalSnapshot,
  getAttachableRows,
  reconcileRows,
} from '../src/row-tracker';

interface RowFixture {
  signature: string;
  attachable?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function snapshot(
  rows: Array<string | RowFixture>,
  options: {
    targetId?: string;
    sampledAt?: number;
  } = {},
) {
  const renderer: RendererTerminalSnapshot = {
    targetId: options.targetId ?? '100:abc',
    sampledAt: options.sampledAt ?? 0,
    displayId: 'display-1',
    displayBounds: { x: 0, y: 0, width: 800, height: 600 },
    viewportRect: { x: 10, y: 10, width: 700, height: 400 },
    rows: rows.map((fixture, index) => {
      const row = typeof fixture === 'string' ? { signature: fixture } : fixture;
      return {
        index,
        signature: row.signature,
        attachable: row.attachable ?? true,
        rect: {
          x: row.x ?? 20,
          y: row.y ?? index * 18,
          width: row.width ?? 120,
          height: row.height ?? 16,
        },
      };
    }),
  };
  return createTerminalSnapshot(renderer);
}

describe('reconcileRows', () => {
  it('recognizes one-row upward scroll and reports an attached top exit', () => {
    const previous = snapshot(['A', 'B', 'C'], { sampledAt: 100 });
    const current = snapshot(['B', 'C', 'D'], { sampledAt: 180 });

    const result = reconcileRows(previous, current, previous.rows[0].key);

    expect(result.status).toBe('scrolled');
    expect(result.offset).toBe(-1);
    expect(result.attachedExitedTop).toBe(true);
    expect(result.holdMovedTooFast).toBe(false);
    expect(result.mappedAttachedKey).toBeNull();
    expect(result.keyMappings.get(previous.rows[1].key)).toBe(
      current.rows[0].key,
    );
  });

  it('uses neighboring physical signatures to defend duplicate matches', () => {
    const contextualPrevious = snapshot(['L', 'A', 'R', 'A']);
    const contextualCurrent = snapshot(['Z', 'L', 'A', 'R']);
    const contextual = reconcileRows(
      contextualPrevious,
      contextualCurrent,
      contextualPrevious.rows[1].key,
    );

    expect(contextual.status).toBe('scrolled');
    expect(contextual.offset).toBe(1);
    expect(contextual.mappedAttachedKey).toBe(contextualCurrent.rows[2].key);

    const ambiguousPrevious = snapshot(['A', 'P', 'A', 'Q']);
    const ambiguousCurrent = snapshot(['A', 'R', 'A', 'S']);
    const ambiguous = reconcileRows(
      ambiguousPrevious,
      ambiguousCurrent,
      ambiguousPrevious.rows[0].key,
    );

    expect(ambiguous.status).toBe('redrawn');
    expect(ambiguous.offset).toBeNull();
    expect(ambiguous.mappedAttachedKey).toBeNull();
  });

  it('treats a clear-screen replacement as a redraw and removes attachment', () => {
    const previous = snapshot(['A', 'B', 'C', 'D']);
    const current = snapshot(['W', 'X', 'Y', 'Z']);

    const result = reconcileRows(previous, current, previous.rows[2].key);

    expect(result.status).toBe('redrawn');
    expect(result.keyMappings.size).toBe(0);
    expect(result.mappedAttachedKey).toBeNull();
    expect(result.attachedExitedTop).toBe(false);
  });

  it('preserves blank physical indices but never emits them as holds', () => {
    const terminal = snapshot([
      'A',
      { signature: 'blank', attachable: false },
      'B',
      { signature: 'invalid', width: 0 },
      { signature: 'nan', x: Number.NaN },
    ]);

    expect(terminal.rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4]);
    expect(getAttachableRows(terminal).map((row) => row.signature)).toEqual([
      'A',
      'B',
    ]);
  });

  it('never carries an attachment across a target switch', () => {
    const previous = snapshot(['A', 'B', 'C']);
    const current = snapshot(['A', 'B', 'C'], { targetId: '200:def' });

    const result = reconcileRows(previous, current, previous.rows[1].key);

    expect(result.targetChanged).toBe(true);
    expect(result.status).toBe('redrawn');
    expect(result.offset).toBeNull();
    expect(result.keyMappings.size).toBe(0);
  });

  it('reports speed and per-sample displacement without overriding a top exit', () => {
    const previous = snapshot(
      ['A', 'B', 'C'],
      { sampledAt: 100 },
    );
    const fast = snapshot(
      [
        { signature: 'A', y: 100 },
        { signature: 'B', y: 118 },
        { signature: 'C', y: 136 },
      ],
      { sampledAt: 180 },
    );
    const fastResult = reconcileRows(previous, fast, previous.rows[1].key);
    expect(fastResult.status).toBe('stable');
    expect(fastResult.holdMovedTooFast).toBe(true);

    const scrolled = snapshot(['B', 'C', 'D'], { sampledAt: 180 });
    const exited = reconcileRows(previous, scrolled, previous.rows[0].key);
    expect(exited.attachedExitedTop).toBe(true);
    expect(exited.holdMovedTooFast).toBe(false);
  });
});
