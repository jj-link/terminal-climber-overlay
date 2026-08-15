import { describe, expect, it } from 'vitest';
import type { RendererTerminalSnapshot } from '../src/contracts';
import {
  BUMP_IMPULSE_FACTOR,
  ClimberSimulation,
  HAND_OFFSET_Y,
  HAND_SPREAD,
  HOLD_INSET,
  LANDING_RECOVERY,
  MAX_BUMP_IMPULSE,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  isUsableClimberHold,
  isUsableHandHold,
  reduceClimberMotion,
  selectClimberSpriteCell,
  type ClimberMotionModel,
} from '../src/climber';
import {
  createClimberMotionModel,
  resetClimberMotionModel,
} from '../src/climber-model';
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

  it('braces one hand during a fast output burst before falling', () => {
    const { simulation } = hangingSimulation();

    simulation.setTerminalSnapshot(
      rendererSnapshot(['A', 'B', 'C'], {
        sampledAt: 100,
        y: 316,
      }),
    );

    expect(simulation.state).toBe('slipping');
    simulation.setTerminalSnapshot(
      rendererSnapshot(['A', 'B', 'C'], {
        sampledAt: 200,
        y: 416,
      }),
    );
    expect(simulation.state).toBe('falling');
    simulation.destroy();
  });

  it('dodges a slow cursor segment and slips one hand on a fast sweep', () => {
    const slow = hangingSimulation();
    const slowY = slow.simulation.position.y + SPRITE_HEIGHT / 2;
    slow.simulation.handlePointerMove({ x: 100, y: slowY }, 0);
    slow.simulation.handlePointerMove({ x: 200, y: slowY }, 1000);
    expect(slow.simulation.state).toBe('hanging');
    slow.simulation.destroy();

    const fast = hangingSimulation();
    const fastY = fast.simulation.position.y + SPRITE_HEIGHT / 2;
    fast.simulation.handlePointerMove({ x: 100, y: fastY }, 0);
    fast.simulation.handlePointerMove({ x: 200, y: fastY }, 100);
    expect(fast.simulation.state).toBe('slipping');
    for (let frame = 0; frame < 6; frame += 1) fast.frames.advance(50);
    expect(fast.simulation.state).toBe('hanging');
    fast.simulation.destroy();
  });

  it('falls with an impulse proportional to the cursor velocity', () => {
    const { simulation, frames } = headlessSimulation();
    advanceUntil(simulation, frames, 'launching');
    const impactY = simulation.position.y + SPRITE_HEIGHT / 2;
    const startX = simulation.position.x - 60;

    simulation.handlePointerMove({ x: startX, y: impactY }, 0);
    simulation.handlePointerMove({ x: startX + 100, y: impactY }, 100);

    expect(simulation.state).toBe('falling');
    expect(simulation.velocity.x).toBeCloseTo(1000 * BUMP_IMPULSE_FACTOR, 5);
    expect(simulation.velocity.y).toBeCloseTo(0, 5);
    simulation.destroy();
  });

  it('caps the cursor bump impulse at MAX_BUMP_IMPULSE', () => {
    const { simulation, frames } = headlessSimulation();
    advanceUntil(simulation, frames, 'launching');
    const impactY = simulation.position.y + SPRITE_HEIGHT / 2;
    const startX = simulation.position.x - 300;

    simulation.handlePointerMove({ x: startX, y: impactY }, 0);
    simulation.handlePointerMove({ x: startX + 500, y: impactY }, 100);

    expect(simulation.state).toBe('falling');
    expect(simulation.velocity.x).toBe(MAX_BUMP_IMPULSE);
    simulation.destroy();
  });

  it('launches the climber in the direction the cursor was travelling', () => {
    const down = headlessSimulation();
    advanceUntil(down.simulation, down.frames, 'launching');
    const downX = down.simulation.position.x + SPRITE_WIDTH / 2;
    const downY = down.simulation.position.y + SPRITE_HEIGHT / 2;
    down.simulation.handlePointerMove({ x: downX, y: downY - 150 }, 0);
    down.simulation.handlePointerMove({ x: downX, y: downY + 150 }, 100);
    expect(down.simulation.state).toBe('falling');
    expect(down.simulation.velocity.y).toBeCloseTo(3000 * BUMP_IMPULSE_FACTOR, 5);
    down.simulation.destroy();

    const up = headlessSimulation();
    advanceUntil(up.simulation, up.frames, 'launching');
    const upX = up.simulation.position.x + SPRITE_WIDTH / 2;
    const upY = up.simulation.position.y + SPRITE_HEIGHT / 2;
    up.simulation.handlePointerMove({ x: upX, y: upY + 150 }, 0);
    up.simulation.handlePointerMove({ x: upX, y: upY - 150 }, 100);
    expect(up.simulation.state).toBe('falling');
    expect(up.simulation.velocity.y).toBeCloseTo(-3000 * BUMP_IMPULSE_FACTOR, 5);
    up.simulation.destroy();
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
  it('uses a narrow text span for one hand and a wider span for both', () => {
    const narrowSnapshot = rendererSnapshot();
    for (const row of narrowSnapshot.rows) {
      row.rect = { x: 100, y: 216, width: 23, height: 16 };
    }
    const narrowRows = getAttachableRows(createTerminalSnapshot(narrowSnapshot));
    expect(narrowRows.every(isUsableHandHold)).toBe(true);
    expect(narrowRows.every(isUsableClimberHold)).toBe(false);
    const narrowFrames = new FrameDriver();
    const narrow = new ClimberSimulation({
      canvas: null,
      displaySize: { width: 300, height: 300 },
      clock: () => narrowFrames.now,
      requestAnimationFrame: narrowFrames.request,
      cancelAnimationFrame: narrowFrames.cancel,
    });
    narrow.setTerminalSnapshot(narrowSnapshot);
    expect(narrow.holdCount).toBe(3);
    advanceUntil(narrow, narrowFrames, 'hanging', 160);
    expect(narrow.state).toBe('hanging');
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

  it('leaves a planted flag behind while one hand slips', () => {
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

    expect(simulation.state).toBe('slipping');
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
      leftHand: { key: null, x: 111, y: 187 },
      rightHand: { key: null, x: 129, y: 187 },
      slip: null,
      routePlanKeys: [],
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

  it('keeps separate hand anchors for narrow and wide text spans', () => {
    const wideSnapshot = rendererSnapshot(['wide']);
    wideSnapshot.rows[0].rect = { x: 100, y: 216, width: 24, height: 16 };
    const wideRows = getAttachableRows(createTerminalSnapshot(wideSnapshot));
    const wideModel = fallingModel();
    wideModel.state = 'grounded';
    wideModel.resumeState = 'grounded';
    wideModel.x = 92;
    for (
      let frame = 0;
      frame < 60 && (wideModel.state as string) !== 'hanging';
      frame += 1
    ) {
      reduceClimberMotion(wideModel, { holds: wideRows }, 0.016);
    }
    expect(wideModel.state).toBe('hanging');
    expect(wideModel.leftHand.key).toBe(wideRows[0].key);
    expect(wideModel.rightHand.key).toBe(wideRows[0].key);

    const narrowSnapshot = rendererSnapshot(['narrow']);
    narrowSnapshot.rows[0].rect = { x: 100, y: 216, width: 23, height: 16 };
    const narrowRows = getAttachableRows(createTerminalSnapshot(narrowSnapshot));
    const narrowModel = fallingModel();
    narrowModel.state = 'grounded';
    narrowModel.resumeState = 'grounded';
    narrowModel.x = 100;
    for (
      let frame = 0;
      frame < 60 && (narrowModel.state as string) !== 'hanging';
      frame += 1
    ) {
      reduceClimberMotion(narrowModel, { holds: narrowRows }, 0.016);
    }
    expect(narrowModel.state).toBe('hanging');
    expect(
      Number(narrowModel.leftHand.key !== null) +
        Number(narrowModel.rightHand.key !== null),
    ).toBe(1);
  });

  it('selects a slightly farther hold when it opens a short route', () => {
    const snapshot = rendererSnapshot([
      'current',
      'near-dead-end',
      'branch',
      'branch-top',
    ]);
    snapshot.rows[0].rect = { x: 100, y: 216, width: 60, height: 16 };
    snapshot.rows[1].rect = { x: 140, y: 184, width: 30, height: 16 };
    snapshot.rows[2].rect = { x: 0, y: 184, width: 30, height: 16 };
    snapshot.rows[3].rect = { x: 0, y: 152, width: 30, height: 16 };
    const holds = getAttachableRows(createTerminalSnapshot(snapshot));
    const model = fallingModel();
    model.state = 'hanging';
    model.resumeState = 'hanging';
    model.x = 110;
    model.y = 200;
    model.attachedKey = holds[0].key;
    model.leftHand = { key: holds[0].key, x: 121, y: 224 };
    model.rightHand = { key: holds[0].key, x: 139, y: 224 };

    reduceClimberMotion(model, { holds }, 0.016);

    expect(model.targetKey).toBe(holds[2].key);
  });

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

  it('uses deliberate summit cadence and freezes it for reduced motion', () => {
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
    expect(selectClimberSpriteCell('summiting', 0, false, false, 0.4)).toBe(25);
    expect(selectClimberSpriteCell('planting', 0, false, false, 0.5)).toBe(27);
    expect(selectClimberSpriteCell('camped', 0, false, false, 0)).toBe(28);
    expect(selectClimberSpriteCell('camped', 0, false, false, 5.5)).toBe(29);
    expect(selectClimberSpriteCell('camped', 0, false, false, 6.5)).toBe(28);
    expect(selectClimberSpriteCell('camped', 0, false, false, 8.5)).toBe(30);
    expect(selectClimberSpriteCell('camped', 0, false, false, 12.1)).toBe(28);
    expect(selectClimberSpriteCell('packing', 1_400, false, true)).toBe(31);
  });

  it('non-reduced falling cycles through cells 14-17 at 140 ms cadence', () => {
    expect(selectClimberSpriteCell('falling', 0, false, false)).toBe(14);
    expect(selectClimberSpriteCell('falling', 140, false, false)).toBe(15);
    expect(selectClimberSpriteCell('falling', 280, false, false)).toBe(16);
    expect(selectClimberSpriteCell('falling', 420, false, false)).toBe(17);
    expect(selectClimberSpriteCell('falling', 560, false, false)).toBe(14);
  });

});

describe('slipping-hand sprite selection', () => {
  it('left-hand slipping selects cells 4 then 5 at 140 ms cadence', () => {
    expect(selectClimberSpriteCell('slipping', 0, false, false, 0, 'left')).toBe(4);
    expect(selectClimberSpriteCell('slipping', 140, false, false, 0, 'left')).toBe(5);
    expect(selectClimberSpriteCell('slipping', 280, false, false, 0, 'left')).toBe(4);
  });

  it('right-hand slipping selects cells 6 then 7 at 140 ms cadence', () => {
    expect(selectClimberSpriteCell('slipping', 0, false, false, 0, 'right')).toBe(6);
    expect(selectClimberSpriteCell('slipping', 140, false, false, 0, 'right')).toBe(7);
    expect(selectClimberSpriteCell('slipping', 280, false, false, 0, 'right')).toBe(6);
  });

  it('reduced motion freezes on cell 4 for left and 6 for right slipping', () => {
    expect(selectClimberSpriteCell('slipping', 0, false, true, 0, 'left')).toBe(4);
    expect(selectClimberSpriteCell('slipping', 140, false, true, 0, 'left')).toBe(4);
    expect(selectClimberSpriteCell('slipping', 0, false, true, 0, 'right')).toBe(6);
    expect(selectClimberSpriteCell('slipping', 140, false, true, 0, 'right')).toBe(6);
  });

  it('fallback to cell 0 when no slippingHand is provided', () => {
    expect(selectClimberSpriteCell('slipping', 0, false, false, 0)).toBe(0);
    expect(selectClimberSpriteCell('slipping', 0, false, false, 0, undefined)).toBe(0);
  });
});

describe('ClimberSimulation reset preserves paused state', () => {
  it('remains paused after reset and resumes to grounded', () => {
    const { simulation, frames } = hangingSimulation();

    // Pause the active climber
    simulation.setPaused(true);
    expect(simulation.state).toBe('paused');

    // Reset while paused — should stay paused, with grounded as resume state
    simulation.reset();
    expect(simulation.state).toBe('paused');

    // Resume — should return to grounded (the reset baseline)
    simulation.setPaused(false);
    expect(simulation.state).toBe('grounded');

    // Confirm the climber proceeds normally from grounded
    frames.advance(16);
    expect(simulation.state).toBe('launching');

    simulation.destroy();
  });

  it('stays grounded after reset when not paused', () => {
    const { simulation } = hangingSimulation();

    // Not paused — reset should go to grounded normally
    simulation.reset();
    expect(simulation.state).toBe('grounded');
    expect(simulation.hasFlag).toBe(false);

    simulation.destroy();
  });

  it('preserves pause through multiple consecutive resets', () => {
    const { simulation } = hangingSimulation();

    simulation.setPaused(true);
    expect(simulation.state).toBe('paused');

    simulation.reset();
    expect(simulation.state).toBe('paused');
    simulation.reset();
    expect(simulation.state).toBe('paused');
    simulation.reset();
    expect(simulation.state).toBe('paused');

    simulation.setPaused(false);
    expect(simulation.state).toBe('grounded');

    simulation.destroy();
  });

  it('clears pointer state after reset while paused', () => {
    const { simulation, frames } = hangingSimulation();

    // Seed pointer tracking so #lastPointer is populated
    const pointerY = simulation.position.y + SPRITE_HEIGHT / 2;
    simulation.handlePointerMove({ x: 100, y: pointerY }, 0);
    simulation.handlePointerMove({ x: 200, y: pointerY }, 1000);
    expect(simulation.state).toBe('hanging');

    // Pause the climber
    simulation.setPaused(true);
    expect(simulation.state).toBe('paused');

    // Reset while paused clears pointer tracking
    simulation.reset();
    expect(simulation.state).toBe('paused');

    // Resume — pointer moves should start fresh (no stale segment intersect)
    simulation.setPaused(false);
    expect(simulation.state).toBe('grounded');

    // Advance to hanging so we have an attached state with a valid hold
    advanceUntil(simulation, frames, 'hanging');

    // Send a pointer movement at an increasing timestamp on the opposite
    // side of the climber from the pre-reset pointer (x=200), so a
    // retained stale segment crosses the current hitbox at high speed.
    // With a correctly cleared reset there is no previous pointer and
    // the climber stays hanging safely.
    const freshPointerY = simulation.position.y + SPRITE_HEIGHT / 2;
    simulation.handlePointerMove(
      { x: simulation.position.x - 1000, y: freshPointerY },
      2000,
    );
    expect(simulation.state).toBe('hanging');

    simulation.destroy();
  });

  it('preserves pause when resetting from summiting state', () => {
    const { simulation, frames } = hangingSimulation();

    // Drive to summiting so we have a different state to pause from
    advanceUntil(simulation, frames, 'summiting', 200);

    // Pause while in summiting state
    simulation.setPaused(true);
    expect(simulation.state).toBe('paused');

    // Reset while paused from summiting
    simulation.reset();
    expect(simulation.state).toBe('paused');

    // Resume — grounded, not summiting
    simulation.setPaused(false);
    expect(simulation.state).toBe('grounded');

    simulation.destroy();
  });

  it('preserves pause when resetting from slipping state', () => {
    const { simulation, frames } = hangingSimulation();

    // Induce slipping via a fast pointer movement (too-large delta)
    const pointerY = simulation.position.y + SPRITE_HEIGHT / 2;
    simulation.handlePointerMove({ x: 100, y: pointerY }, 0);
    simulation.handlePointerMove({ x: 200, y: pointerY }, 50);
    expect(simulation.state).toBe('slipping');

    // Pause while slipping
    simulation.setPaused(true);
    expect(simulation.state).toBe('paused');

    // Reset while paused from slipping
    simulation.reset();
    expect(simulation.state).toBe('paused');

    // Resume — grounded, not slipping
    simulation.setPaused(false);
    expect(simulation.state).toBe('grounded');

    simulation.destroy();
  });

  it('clears flag when resetting while paused', () => {
    const { simulation } = campedSimulation();
    expect(simulation.hasFlag).toBe(true);

    simulation.setPaused(true);
    simulation.reset();
    expect(simulation.state).toBe('paused');
    expect(simulation.hasFlag).toBe(false);

    simulation.destroy();
  });
});

describe('climber motion model factory', () => {
  it('createClimberMotionModel produces separate hand anchors and route array', () => {
    const model = createClimberMotionModel(300, 300);
    expect(model.state).toBe('grounded');
    expect(model.leftHand.key).toBeNull();
    expect(model.rightHand.key).toBeNull();
    expect(model.slip).toBeNull();
    expect(model.routePlanKeys).toEqual([]);
    expect(model.x).toBe((300 - SPRITE_WIDTH) / 2);
    expect(model.y).toBe(300 - SPRITE_HEIGHT);
    expect(model.leftHand.x).toBe(300 / 2 - HAND_SPREAD);
    expect(model.rightHand.x).toBe(300 / 2 + HAND_SPREAD);
    expect(model.flagKey).toBeNull();
  });

  it('resetClimberMotionModel clears hand anchors, slip, route, travel, follow, flag', () => {
    const model = createClimberMotionModel(300, 300);
    model.state = 'hanging';
    model.resumeState = 'hanging';
    model.attachedKey = 'some-key';
    model.leftHand = { key: 'k1', x: 100, y: 200 };
    model.rightHand = { key: 'k1', x: 118, y: 200 };
    model.slip = { side: 'left', x: 100, y: 200, elapsed: 0.1, duration: 0.28, vx: 0, vy: 70 };
    model.routePlanKeys = ['r1', 'r2'];
    model.travel = { kind: 'climb', targetKey: 't1', leadHand: 'right', trailingKey: 'k1', startX: 0, startY: 0, startLeadX: 0, startLeadY: 0, targetBodyX: 0, targetHandX: 0, targetHandY: 0, elapsed: 0, duration: 0.42 };
    model.holdFollow = { startX: 0, startY: 0, targetX: 0, targetY: 0, handStart: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }, handTarget: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }, elapsed: 0, duration: 0.15 };
    model.flagKey = 'f1';
    model.flagAnchorRatio = 0.5;

    resetClimberMotionModel(model);

    expect(model.state).toBe('grounded');
    expect(model.leftHand.key).toBeNull();
    expect(model.rightHand.key).toBeNull();
    expect(model.slip).toBeNull();
    expect(model.routePlanKeys).toEqual([]);
    expect(model.attachedKey).toBeNull();
    expect(model.travel).toBeNull();
    expect(model.holdFollow).toBeNull();
    expect(model.flagKey).toBeNull();
  });

  it('display dimensions survive reset', () => {
    const model = createClimberMotionModel(400, 200);
    expect(model.displayWidth).toBe(400);
    expect(model.displayHeight).toBe(200);
    model.x = 500;
    model.y = 100;
    resetClimberMotionModel(model);
    expect(model.displayWidth).toBe(400);
    expect(model.displayHeight).toBe(200);
  });

  it('two models have distinct left/right anchors and route arrays (identity isolation)', () => {
    const a = createClimberMotionModel(300, 300);
    const b = createClimberMotionModel(400, 400);

    // Distinct anchor positions from different display sizes
    expect(a.leftHand.x).not.toBe(b.leftHand.x);
    expect(a.rightHand.x).not.toBe(b.rightHand.x);
    expect(a.leftHand).not.toBe(b.leftHand);
    expect(a.rightHand).not.toBe(b.rightHand);

    // Distinct route arrays
    expect(a.routePlanKeys).not.toBe(b.routePlanKeys);

    // Mutating one model must not affect the other
    a.leftHand.x = 999;
    a.routePlanKeys.push('test-key');
    expect(b.leftHand.x).not.toBe(999);
    expect(b.routePlanKeys).toEqual([]);
  });
});
