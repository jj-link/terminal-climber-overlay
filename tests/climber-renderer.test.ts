import { describe, expect, it } from 'vitest';
import {
  ClimberRenderer,
  type ClimberRenderFrame,
} from '../src/climber-renderer';
import { SPRITE_WIDTH, SPRITE_HEIGHT } from '../src/climber-model';
import type { ClimberMotionModel } from '../src/climber-model';
import type { TerminalBackendStatus } from '../src/contracts';
import type { TerminalRow } from '../src/row-tracker';

/**
 * Minimal call-recording mock that satisfies CanvasRenderingContext2D
 * through the subset of properties/methods the renderer touches.
 */
class MockContext {
  readonly calls: string[] = [];
  readonly drawImageCalls: Array<{
    sourceRect: [number, number, number, number];
    destRect: [number, number, number, number];
  }> = [];
  #callsets = new Set<string>();

  _record(name: string): void {
    this.calls.push(name);
    this.#callsets.add(name);
  }
  _called(name: string): boolean {
    return this.#callsets.has(name);
  }
  _notCalled(name: string): boolean {
    return !this.#callsets.has(name);
  }

  // CanvasState
  setTransform(_a: number, _b: number, _c: number, _d: number, _e: number, _f: number): void {
    this._record('setTransform');
  }

  // Compositing (setter)
  set imageSmoothingEnabled(_value: boolean) {
    this._record('imageSmoothingEnabled=');
  }

  // DrawingRect
  clearRect(_x: number, _y: number, _w: number, _h: number): void {
    this._record('clearRect');
  }
  fillRect(_x: number, _y: number, _w: number, _h: number): void {
    this._record('fillRect');
  }

  // DrawingImages
  drawImage(
    _image: CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void {
    this._record('drawImage');
    this.drawImageCalls.push({
      sourceRect: [sx, sy, sw, sh],
      destRect: [dx, dy, dw, dh],
    });
  }

  // Path methods the campsite calls
  beginPath(): void { this._record('beginPath'); }
  moveTo(_x: number, _y: number): void { this._record('moveTo'); }
  lineTo(_x: number, _y: number): void { this._record('lineTo'); }
  closePath(): void { this._record('closePath'); }
  stroke(): void { this._record('stroke'); }
  fill(): void { this._record('fill'); }

  // Fill/stroke style setters
  set fillStyle(_v: string) { this._record('fillStyle='); }
  set strokeStyle(_v: string) { this._record('strokeStyle='); }
  set lineWidth(_v: number) { this._record('lineWidth='); }
}

function mockCanvas(context: MockContext): HTMLCanvasElement {
  const canvas = {
    width: 600,
    height: 600,
    getContext(_id: '2d'): MockContext | null {
      return context;
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 300, height: 300, top: 0, right: 300, bottom: 300, left: 0 };
    },
    clientWidth: 300,
    clientHeight: 300,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return canvas;
}

function slippingFrame(context: MockContext): {
  renderer: ClimberRenderer;
  frame: ClimberRenderFrame;
} {
  const spriteImage = { width: 384, height: 192 } as CanvasImageSource;
  const canvas = mockCanvas(context);
  const renderer = new ClimberRenderer({
    canvas,
    spriteImage,
    createResizeObserver: () => ({ observe() {}, disconnect() {} }),
    reducedMotion: false,
  });
  // Reset recorded calls from construction
  context.calls.length = 0;
  context.drawImageCalls.length = 0;

  const motion = {
    state: 'slipping',
    resumeState: 'slipping',
    x: 100,
    y: 200,
    vx: 0,
    vy: 0,
    displayWidth: 300,
    displayHeight: 300,
    paceDirection: 1 as const,
    attachedKey: 'hold-1',
    targetKey: null,
    leftHand: { key: 'hold-1', x: 115, y: 220 },
    // Deliberately distant free-hand coordinate (simulating released hand)
    rightHand: { key: null, x: 9999, y: 9999 },
    slip: { side: 'right' as const, x: 9999, y: 9999, elapsed: 0.1, duration: 0.28, vx: 50, vy: 70 },
    routePlanKeys: [],
    phaseElapsed: 0.1,
    travel: null,
    holdFollow: null,
    grapple: null,
    summitStableElapsed: 0,
    targetSnapshotCount: 0,
    routeSearchAboveY: Number.POSITIVE_INFINITY,
    routeRetryElapsed: 0,
    summitStartY: 0,
    flagKey: null,
    flagAnchorRatio: 0.84,
  } as ClimberMotionModel;

  const frame: ClimberRenderFrame = {
    motion,
    holds: [] as readonly TerminalRow[],
    backendStatus: 'initializing' as TerminalBackendStatus,
    timestamp: 0,
    bumped: false,
  };

  return { renderer, frame };
}

function fallingFrame(context: MockContext): {
  renderer: ClimberRenderer;
  frame: ClimberRenderFrame;
} {
  const spriteImage = { width: 384, height: 192 } as CanvasImageSource;
  const canvas = mockCanvas(context);
  const renderer = new ClimberRenderer({
    canvas,
    spriteImage,
    createResizeObserver: () => ({ observe() {}, disconnect() {} }),
    reducedMotion: false,
  });
  context.calls.length = 0;
  context.drawImageCalls.length = 0;

  const motion = {
    state: 'falling',
    resumeState: 'falling',
    x: 120,
    y: 80,
    vx: 100,
    vy: 600,
    displayWidth: 300,
    displayHeight: 300,
    paceDirection: 1 as const,
    attachedKey: null,
    targetKey: null,
    // Both hands have stale/distant coordinates
    leftHand: { key: null, x: 9999, y: 50 },
    rightHand: { key: null, x: 9999, y: 50 },
    slip: null,
    routePlanKeys: [],
    phaseElapsed: 0,
    travel: null,
    holdFollow: null,
    grapple: null,
    summitStableElapsed: 0,
    targetSnapshotCount: 0,
    routeSearchAboveY: Number.POSITIVE_INFINITY,
    routeRetryElapsed: 0,
    summitStartY: 0,
    flagKey: null,
    flagAnchorRatio: 0.84,
  } as ClimberMotionModel;

  const frame: ClimberRenderFrame = {
    motion,
    holds: [] as readonly TerminalRow[],
    backendStatus: 'initializing' as TerminalBackendStatus,
    timestamp: 0,
    bumped: false,
  };

  return { renderer, frame };
}

describe('ClimberRenderer canvas contract', () => {
  it('renders a slipping frame with one drawImage and no path/stroke', () => {
    const context = new MockContext();
    const { renderer, frame } = slippingFrame(context);

    renderer.render(frame);

    // Exactly one drawImage, no path/stroke
    expect(context._called('drawImage')).toBe(true);
    expect(context._notCalled('beginPath')).toBe(true);
    expect(context._notCalled('moveTo')).toBe(true);
    expect(context._notCalled('lineTo')).toBe(true);
    expect(context._notCalled('stroke')).toBe(true);
    expect(context._notCalled('fill')).toBe(true);
    // Campsite should not fire because backendStatus is not tracking/paused
    expect(context._notCalled('fillRect')).toBe(true);

    // Draw destination must match climber position
    expect(context.drawImageCalls).toHaveLength(1);
    const [call] = context.drawImageCalls;
    expect(call.destRect).toEqual([
      Math.round(frame.motion.x),
      Math.round(frame.motion.y),
      SPRITE_WIDTH,
      SPRITE_HEIGHT,
    ]);
  });

  it('renders a falling frame with one drawImage and no path/stroke', () => {
    const context = new MockContext();
    const { renderer, frame } = fallingFrame(context);

    renderer.render(frame);

    expect(context._called('drawImage')).toBe(true);
    expect(context._notCalled('beginPath')).toBe(true);
    expect(context._notCalled('moveTo')).toBe(true);
    expect(context._notCalled('lineTo')).toBe(true);
    expect(context._notCalled('stroke')).toBe(true);
    expect(context._notCalled('fill')).toBe(true);
    expect(context._notCalled('fillRect')).toBe(true);

    expect(context.drawImageCalls).toHaveLength(1);
    const [call] = context.drawImageCalls;
    expect(call.destRect).toEqual([
      Math.round(frame.motion.x),
      Math.round(frame.motion.y),
      SPRITE_WIDTH,
      SPRITE_HEIGHT,
    ]);
  });

  it('destroy is idempotent and does not fail', () => {
    const context = new MockContext();
    const { renderer } = slippingFrame(context);
    // Should not throw
    renderer.destroy();
    renderer.destroy();
  });
});
