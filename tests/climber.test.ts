import { describe, expect, it } from 'vitest';
import type { RendererTerminalSnapshot } from '../src/contracts';
import {
  ClimberSimulation,
  HAND_OFFSET_Y,
  HAND_SPREAD,
  HOLD_INSET,
  LANDING_RECOVERY,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  isUsableClimberHold,
  reduceClimberMotion,
  selectClimberSpriteCell,
  type ClimberMotionModel,
} from '../src/climber';
import { createTerminalSnapshot, getAttachableRows } from '../src/row-tracker';

class FrameDriver {
  now = 0;
  #nextId = 1;
  #callbacks = new Map<number, FrameRequestCallback>();

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    this.#callbacks.delete(id);
  };

  advance(milliseconds = 16): void {
    this.now += milliseconds;
    const entry = this.#callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error('No animation frame is scheduled');
    this.#callbacks.delete(entry[0]);
    entry[1](this.now);
  }
}

function rendererSnapshot(
  signatures: string[] = ['A', 'B', 'C'],
  options: {
    sampledAt?: number;
    y?: number;
    targetId?: string;
    displayId?: string;
  } = {},
): RendererTerminalSnapshot {
  const y = options.y ?? 216;
  return {
    targetId: options.targetId ?? '100:abc',
    sampledAt: options.sampledAt ?? 0,
    displayId: options.displayId ?? 'display-1',
    displayBounds: { x: 0, y: 0, width: 300, height: 300 },
    viewportRect: { x: 0, y: 0, width: 300, height: 250 },
    rows: signatures.map((signature, index) => ({
      index,
      segmentIndex: 0,
      signature,
      attachable: true,
      rect: { x: 0, y, width: 300, height: 16 },
    })),
  };
}

function headlessSimulation(): {
  simulation: ClimberSimulation;
  frames: FrameDriver;
} {
  const frames = new FrameDriver();
  const simulation = new ClimberSimulation({
    canvas: null,
    displaySize: { width: 300, height: 300 },
    clock: () => frames.now,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
  });
  simulation.setTerminalSnapshot(rendererSnapshot());
  return { simulation, frames };
}

function advanceUntil(
  simulation: ClimberSimulation,
  frames: FrameDriver,
  expected: string,
  limit = 100,
): void {
  for (let frame = 0; frame < limit && simulation.state !== expected; frame += 1) {
    frames.advance(16);
  }
  expect(simulation.state).toBe(expected);
}

function hangingSimulation(): {
  simulation: ClimberSimulation;
  frames: FrameDriver;
} {
  const fixture = headlessSimulation();
  advanceUntil(fixture.simulation, fixture.frames, 'hanging');
  return fixture;
}

function campedSimulation(): {
  simulation: ClimberSimulation;
  frames: FrameDriver;
} {
  const fixture = hangingSimulation();
  advanceUntil(fixture.simulation, fixture.frames, 'camped', 240);
  expect(fixture.simulation.hasFlag).toBe(true);
  return fixture;
}

describe('ClimberSimulation attachment rules', () => {
  it('keeps hanging through normal interpolated mapped-row movement', () => {
    const { simulation, frames } = hangingSimulation();

    simulation.setTerminalSnapshot(
      rendererSnapshot(['A', 'B', 'C'], {
        sampledAt: 100,
        y: 217,
      }),
    );
    expect(simulation.state).toBe('hanging');
    frames.advance(16);
    expect(simulation.state).toBe('hanging');

    simulation.destroy();
  });

  it('falls instead of teleporting when the held row exceeds 750 DIP/s', () => {
    const { simulation } = hangingSimulation();

    simulation.setTerminalSnapshot(
      rendererSnapshot(['A', 'B', 'C'], {
        sampledAt: 100,
        y: 316,
      }),
    );

    expect(simulation.state).toBe('falling');
    simulation.destroy();
  });

  it('dodges a slow cursor segment and detaches with fast horizontal impulse', () => {
    const slow = hangingSimulation();
    const slowY = slow.simulation.position.y + SPRITE_HEIGHT / 2;
    slow.simulation.handlePointerMove({ x: 100, y: slowY }, 0);
    slow.simulation.handlePointerMove({ x: 200, y: slowY }, 1000);
    expect(slow.simulation.state).toBe('hanging');
    slow.simulation.destroy();

    const fast = hangingSimulation();
    const fastY = fast.simulation.position.y + SPRITE_HEIGHT / 2;
    const impactX = fast.simulation.position.x;
    fast.simulation.handlePointerMove({ x: 100, y: fastY }, 0);
    fast.simulation.handlePointerMove({ x: 200, y: fastY }, 100);
    expect(fast.simulation.state).toBe('falling');
    fast.frames.advance(50);
    expect(fast.simulation.position.x).toBeGreaterThan(impactX);
    fast.simulation.destroy();
  });

  it('re-enters at exactly the display top when its attached row exits upward', () => {
    const { simulation } = hangingSimulation();

    simulation.setTerminalSnapshot(
      rendererSnapshot(['B', 'C', 'D'], { sampledAt: 80 }),
    );

    expect(simulation.state).toBe('falling');
    expect(simulation.position.y).toBe(-SPRITE_HEIGHT);
    simulation.destroy();
  });

  it('freezes a brief status interruption, then releases after 500 ms', () => {
    const { simulation, frames } = hangingSimulation();

    simulation.setTerminalStatus('no-terminal');
    frames.advance(400);
    expect(simulation.state).toBe('hanging');
    frames.advance(101);
    expect(simulation.state).toBe('falling');

    simulation.destroy();
  });
  it('requires both hand anchors to fit inside a three-DIP inset', () => {
    const narrowSnapshot = rendererSnapshot();
    for (const row of narrowSnapshot.rows) {
      row.rect = { x: 100, y: 216, width: 23, height: 16 };
    }
    const narrowFrames = new FrameDriver();
    const narrow = new ClimberSimulation({
      canvas: null,
      displaySize: { width: 300, height: 300 },
      clock: () => narrowFrames.now,
      requestAnimationFrame: narrowFrames.request,
      cancelAnimationFrame: narrowFrames.cancel,
    });
    narrow.setTerminalSnapshot(narrowSnapshot);
    expect(narrow.holdCount).toBe(0);
    for (let frame = 0; frame < 20; frame += 1) narrowFrames.advance(16);
    expect(narrow.state).toBe('grounded');
    narrow.destroy();

    const fittedSnapshot = rendererSnapshot();
    for (const row of fittedSnapshot.rows) {
      row.rect = { x: 100, y: 216, width: 24, height: 16 };
    }
    const fittedRows = getAttachableRows(createTerminalSnapshot(fittedSnapshot));
    expect(fittedRows.every(isUsableClimberHold)).toBe(true);
    const fittedFrames = new FrameDriver();
    const fitted = new ClimberSimulation({
      canvas: null,
      displaySize: { width: 300, height: 300 },
      clock: () => fittedFrames.now,
      requestAnimationFrame: fittedFrames.request,
      cancelAnimationFrame: fittedFrames.cancel,
    });
    fitted.setTerminalSnapshot(fittedSnapshot);
    advanceUntil(fitted, fittedFrames, 'hanging', 160);

    const handCenterX = fitted.position.x + SPRITE_WIDTH / 2;
    const leftHandX = handCenterX - HAND_SPREAD;
    const rightHandX = handCenterX + HAND_SPREAD;
    const handY = fitted.position.y + HAND_OFFSET_Y;
    expect(leftHandX).toBe(100 + HOLD_INSET);
    expect(rightHandX).toBe(100 + 24 - HOLD_INSET);
    expect(handY).toBeGreaterThanOrEqual(216 + HOLD_INSET);
    expect(handY).toBeLessThanOrEqual(216 + 16 - HOLD_INSET);
    fitted.destroy();
  });
  it('stays attached when an uncommitted route disappears at a dead end', () => {
    const { simulation, frames } = hangingSimulation();
    const candidate = rendererSnapshot(['NEW', 'A', 'B', 'C'], {
      sampledAt: 100,
    });
    candidate.rows[0].rect = { x: 260, y: 180, width: 30, height: 16 };

    simulation.setTerminalSnapshot(candidate);
    frames.advance(16);
    for (const sampledAt of [180, 260]) {
      candidate.sampledAt = sampledAt;
      simulation.setTerminalSnapshot(candidate);
      frames.advance(16);
    }
    expect(simulation.state).toBe('shimmying');
    simulation.setTerminalSnapshot(
      rendererSnapshot(['A', 'B', 'C'], { sampledAt: 340 }),
    );

    expect(simulation.state).toBe('hanging');
    for (let frame = 0; frame < 20; frame += 1) frames.advance(16);
    expect(simulation.state).toBe('hanging');
    simulation.destroy();
  });

  it('skips a volatile nearest row and confirms a stable higher route', () => {
    const { simulation, frames } = hangingSimulation();
    const route = rendererSnapshot(
      ['volatile-1', 'stable', 'A', 'B', 'C'],
      { sampledAt: 100 },
    );
    route.rows[0].rect = { x: 0, y: 184, width: 300, height: 16 };
    route.rows[1].rect = { x: 0, y: 152, width: 300, height: 16 };

    simulation.setTerminalSnapshot(route);
    frames.advance(16);
    for (const [volatileSignature, sampledAt] of [
      ['volatile-2', 180],
      ['volatile-3', 260],
      ['volatile-4', 340],
    ] as const) {
      route.sampledAt = sampledAt;
      route.rows[0].signature = volatileSignature;
      simulation.setTerminalSnapshot(route);
      frames.advance(16);
    }

    expect(simulation.state).toBe('climbing');
    simulation.destroy();
  });

  it('never treats a lower route dead end as the terminal summit', () => {
    const frames = new FrameDriver();
    const simulation = new ClimberSimulation({
      canvas: null,
      displaySize: { width: 300, height: 300 },
      clock: () => frames.now,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    });
    const splitRoute = rendererSnapshot(['lower', 'upper']);
    splitRoute.rows[0].rect = { x: 0, y: 216, width: 30, height: 16 };
    splitRoute.rows[1].rect = { x: 250, y: 80, width: 30, height: 16 };
    simulation.setTerminalSnapshot(splitRoute);

    advanceUntil(simulation, frames, 'hanging', 160);
    for (let frame = 0; frame < 200; frame += 1) frames.advance(16);

    expect(simulation.state).toBe('hanging');
    expect(simulation.hasFlag).toBe(false);
    simulation.destroy();
  });


  it('waits for a stable summit before mantling and planting a flag', () => {
    const { simulation, frames } = hangingSimulation();

    for (let frame = 0; frame < 70; frame += 1) frames.advance(16);
    expect(simulation.state).toBe('hanging');
    advanceUntil(simulation, frames, 'summiting', 10);
    advanceUntil(simulation, frames, 'camped', 120);
    expect(simulation.hasFlag).toBe(true);

    simulation.destroy();
  });

  it('packs its campsite when a new reachable row appears above', () => {
    const { simulation, frames } = campedSimulation();
    const extended = rendererSnapshot(['NEW', 'A', 'B', 'C'], {
      sampledAt: 100,
    });
    extended.rows[0].rect = { x: 0, y: 180, width: 300, height: 16 };

    simulation.setTerminalSnapshot(extended);
    frames.advance(16);
    for (const sampledAt of [180, 260]) {
      extended.sampledAt = sampledAt;
      simulation.setTerminalSnapshot(extended);
      frames.advance(16);
    }
    expect(simulation.state).toBe('packing');
    advanceUntil(simulation, frames, 'hanging', 40);
    expect(simulation.hasFlag).toBe(false);

    simulation.destroy();
  });

  it('leaves a planted flag behind after a mouse knockoff', () => {
    const { simulation } = campedSimulation();
    const impactY = simulation.position.y + SPRITE_HEIGHT / 2;

    simulation.handlePointerMove(
      { x: simulation.position.x - 30, y: impactY },
      0,
    );
    simulation.handlePointerMove(
      { x: simulation.position.x + SPRITE_WIDTH + 30, y: impactY },
      100,
    );

    expect(simulation.state).toBe('falling');
    expect(simulation.hasFlag).toBe(true);
    simulation.destroy();
  });

  it('removes the campsite when its summit row exits upward', () => {
    const { simulation } = campedSimulation();

    simulation.setTerminalSnapshot(
      rendererSnapshot(['B', 'C', 'D'], { sampledAt: 80 }),
    );

    expect(simulation.state).toBe('falling');
    expect(simulation.position.y).toBe(-SPRITE_HEIGHT);
    expect(simulation.hasFlag).toBe(false);
    simulation.destroy();
  });

});

describe('DOM-free climber motion reducer', () => {
  function fallingModel(): ClimberMotionModel {
    return {
      state: 'falling',
      resumeState: 'falling',
      x: 100,
      y: 180,
      vx: 0,
      vy: 300,
      displayWidth: 300,
      displayHeight: 300,
      paceDirection: 1,
      attachedKey: null,
      targetKey: null,
      phaseElapsed: 0,
      travel: null,
      holdFollow: null,
      summitStableElapsed: 0,
      summitStartY: 0,
      targetSnapshotCount: 0,
      routeSearchAboveY: Number.POSITIVE_INFINITY,
      routeRetryElapsed: 0,
      flagKey: null,
      flagAnchorRatio: 0.84,
    };
  }

  it('never catches an intermediate hold while falling', () => {
    const terminal = createTerminalSnapshot(rendererSnapshot(['A', 'B', 'C']));
    const model = fallingModel();

    reduceClimberMotion(model, { holds: getAttachableRows(terminal) }, 0.05);

    expect(model.y).toBeGreaterThan(180);
    expect(model.state).toBe('falling');
    expect(model.attachedKey).toBeNull();
  });

  it('lands at the display floor, recovers for 0.35 s, then selects the lowest hold', () => {
    const snapshot = rendererSnapshot(['top', 'middle', 'lowest']);
    snapshot.rows[0].rect = { x: 0, y: 80, width: 300, height: 16 };
    snapshot.rows[1].rect = { x: 0, y: 130, width: 300, height: 16 };
    snapshot.rows[2].rect = { x: 0, y: 210, width: 300, height: 16 };
    const terminal = createTerminalSnapshot(snapshot);
    const holds = getAttachableRows(terminal);
    const model = fallingModel();
    model.y = 246;
    model.vy = 900;

    reduceClimberMotion(model, { holds }, 0.05);
    expect(model.state).toBe('landing');
    expect(model.y).toBe(300 - SPRITE_HEIGHT);

    for (let elapsed = 0; elapsed < LANDING_RECOVERY; elapsed += 0.05) {
      reduceClimberMotion(model, { holds }, 0.05);
    }
    expect(model.state).toBe('grounded');

    reduceClimberMotion(model, { holds }, 0.016);
    expect(model.state).toBe('launching');
    expect(model.travel?.targetKey).toBe(terminal.rows[2].key);
  });

  it('moves laterally only as required to reach the target text span', () => {
    const snapshot = rendererSnapshot(['current', 'target']);
    snapshot.rows[0].rect = { x: 80, y: 216, width: 100, height: 16 };
    snapshot.rows[1].rect = { x: 150, y: 184, width: 80, height: 16 };
    const terminal = createTerminalSnapshot(snapshot);
    const holds = getAttachableRows(terminal);
    const model = fallingModel();
    model.state = 'hanging';
    model.resumeState = 'hanging';
    model.y = 217;
    model.vy = 0;
    model.attachedKey = holds[0].key;
    model.targetKey = holds[1].key;
    model.targetSnapshotCount = 3;

    reduceClimberMotion(model, { holds }, 0.016);
    expect(model.state).toBe('shimmying');
    for (let frame = 0; frame < 10; frame += 1) {
      reduceClimberMotion(model, { holds }, 0.05);
    }

    expect(model.state).toBe('climbing');
    expect(model.travel?.targetHandX).toBe(
      snapshot.rows[1].rect.x + HOLD_INSET + HAND_SPREAD,
    );
    for (let frame = 0; frame < 9; frame += 1) {
      reduceClimberMotion(model, { holds }, 0.05);
    }
    const handCenterX = model.x + SPRITE_WIDTH / 2;
    expect(handCenterX - HAND_SPREAD).toBe(
      snapshot.rows[1].rect.x + HOLD_INSET,
    );
    expect(handCenterX + HAND_SPREAD).toBeLessThanOrEqual(
      snapshot.rows[1].rect.x +
        snapshot.rows[1].rect.width -
        HOLD_INSET,
    );
  });

  it('freezes decorative atlas cycling without changing state-specific frames', () => {
    expect(selectClimberSpriteCell('hanging', 0, false, false)).toBe(0);
    expect(selectClimberSpriteCell('hanging', 140, false, false)).toBe(1);
    expect(selectClimberSpriteCell('hanging', 0, false, true)).toBe(0);
    expect(selectClimberSpriteCell('hanging', 1_400, false, true)).toBe(0);
    expect(selectClimberSpriteCell('falling', 1_400, false, true)).toBe(14);
    expect(selectClimberSpriteCell('landing', 1_400, false, true)).toBe(18);
    expect(selectClimberSpriteCell('hanging', 1_400, true, true)).toBe(23);
    expect(selectClimberSpriteCell('summiting', 0, false, true)).toBe(24);
    expect(selectClimberSpriteCell('planting', 0, false, true)).toBe(26);
    expect(selectClimberSpriteCell('camped', 1_400, false, true)).toBe(28);
    expect(selectClimberSpriteCell('packing', 1_400, false, true)).toBe(31);
  });

});
