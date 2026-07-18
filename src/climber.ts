import type {
  Rect,
  RendererTerminalSnapshot,
  TerminalBackendStatus,
} from './contracts';
import {
  createTerminalSnapshot,
  getAttachableRows,
  reconcileRows,
  type TerminalRow,
  type TerminalSnapshot,
} from './row-tracker';

export type ClimberState =
  | 'grounded'
  | 'launching'
  | 'hanging'
  | 'shimmying'
  | 'climbing'
  | 'falling'
  | 'landing'
  | 'paused';

export interface Point {
  x: number;
  y: number;
}

export interface ClimberObservableState {
  state: ClimberState;
  holdCount: number;
  position: Readonly<Point>;
}

interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

export interface ClimberSimulationOptions {
  /** Pass null only for a headless simulation with injected frame dependencies. */
  canvas: HTMLCanvasElement | null;
  spriteUrl?: string;
  spriteImage?: CanvasImageSource;
  onStateChange?: (state: ClimberObservableState) => void;
  clock?: () => number;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => ResizeObserverLike;
  displaySize?: { width: number; height: number };
  autoStart?: boolean;
  /** Overrides the browser media query; physics and state timing are unchanged. */
  reducedMotion?: boolean;
}

interface Travel {
  kind: 'launch' | 'climb';
  targetKey: string;
  startX: number;
  startY: number;
  targetHandX: number;
  targetHandY: number;
  elapsed: number;
  duration: number;
}

interface HoldFollow {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  elapsed: number;
  duration: number;
}

export interface ClimberMotionModel {
  state: ClimberState;
  resumeState: Exclude<ClimberState, 'paused'>;
  x: number;
  y: number;
  vx: number;
  vy: number;
  displayWidth: number;
  displayHeight: number;
  paceDirection: -1 | 1;
  attachedKey: string | null;
  targetKey: string | null;
  phaseElapsed: number;
  travel: Travel | null;
  holdFollow: HoldFollow | null;
}

export interface ClimberMotionEnvironment {
  /** Pre-filtered rows on which both hands can fit. */
  holds: readonly TerminalRow[];
  /** Cache this with the snapshot to avoid sorting in the animation loop. */
  medianRowHeight?: number;
}

export const SPRITE_WIDTH = 40;
export const SPRITE_HEIGHT = 52;
export const GRAVITY = 1900;
export const MAX_FALL_SPEED = 1450;
export const SHIMMY_SPEED = 92;
export const CLIMB_DURATION = 0.42;
export const LAUNCH_DURATION = 0.7;
export const LANDING_RECOVERY = 0.35;
export const POINTER_BUMP_SPEED = 180;
export const STATUS_GRACE_MS = 500;

export const HAND_SPREAD = 9;
export const HAND_OFFSET_Y = 7;
export const HOLD_INSET = 3;
const HAND_CENTER_OFFSET_X = SPRITE_WIDTH / 2;
const MIN_HOLD_WIDTH = 2 * (HAND_SPREAD + HOLD_INSET);
const MIN_HOLD_HEIGHT = 2 * HOLD_INSET;
const HITBOX_PADDING = 10;
const PACE_SPEED = 44;
const MAX_FRAME_DELTA = 0.05;
const EMPTY_HOLDS: readonly TerminalRow[] = Object.freeze([]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function moveToward(value: number, target: number, distance: number): number {
  if (Math.abs(target - value) <= distance) return target;
  return value + Math.sign(target - value) * distance;
}

function smoothstep(progress: number): number {
  const t = clamp(progress, 0, 1);
  return t * t * (3 - 2 * t);
}

function rowByKey(
  holds: readonly TerminalRow[],
  key: string | null,
): TerminalRow | undefined {
  return key ? holds.find((row) => row.key === key) : undefined;
}

function rowCenterY(row: TerminalRow): number {
  return row.rect.y + row.rect.height / 2;
}

export function isUsableClimberHold(row: TerminalRow): boolean {
  return (
    row.attachable &&
    row.rect.width >= MIN_HOLD_WIDTH &&
    row.rect.height >= MIN_HOLD_HEIGHT
  );
}

function minimumHandCenterX(row: TerminalRow): number {
  return row.rect.x + HOLD_INSET + HAND_SPREAD;
}

function maximumHandCenterX(row: TerminalRow): number {
  return row.rect.x + row.rect.width - HOLD_INSET - HAND_SPREAD;
}

function attachmentHandY(row: TerminalRow): number {
  return clamp(
    rowCenterY(row),
    row.rect.y + HOLD_INSET,
    row.rect.y + row.rect.height - HOLD_INSET,
  );
}

function medianRowHeight(holds: readonly TerminalRow[]): number {
  if (holds.length === 0) return 16;
  const heights = holds.map((row) => row.rect.height).sort((a, b) => a - b);
  const middle = Math.floor(heights.length / 2);
  return heights.length % 2
    ? heights[middle]
    : (heights[middle - 1] + heights[middle]) / 2;
}

function setMotionState(model: ClimberMotionModel, state: ClimberState): void {
  model.state = state;
  model.phaseElapsed = 0;
  if (state !== 'paused') model.resumeState = state;
}

function beginFall(model: ClimberMotionModel, vx = model.vx): void {
  model.attachedKey = null;
  model.targetKey = null;
  model.travel = null;
  model.holdFollow = null;
  model.vx = vx;
  model.vy = Math.max(model.vy, 0);
  setMotionState(model, 'falling');
}

function attachToRow(model: ClimberMotionModel, row: TerminalRow): void {
  const handCenterX = clamp(
    model.x + HAND_CENTER_OFFSET_X,
    minimumHandCenterX(row),
    maximumHandCenterX(row),
  );
  model.x = handCenterX - HAND_CENTER_OFFSET_X;
  model.y = attachmentHandY(row) - HAND_OFFSET_Y;
  model.vx = 0;
  model.vy = 0;
  model.attachedKey = row.key;
  model.targetKey = null;
  model.travel = null;
  setMotionState(model, 'hanging');
}

function chooseLowestHold(
  holds: readonly TerminalRow[],
  handCenterX: number,
): TerminalRow | undefined {
  let best: TerminalRow | undefined;
  let bestBottom = Number.NEGATIVE_INFINITY;
  let bestHorizontal = Number.POSITIVE_INFINITY;
  for (const candidate of holds) {
    if (!isUsableClimberHold(candidate)) continue;
    const bottom = candidate.rect.y + candidate.rect.height;
    const horizontal = Math.abs(
      clamp(
        handCenterX,
        minimumHandCenterX(candidate),
        maximumHandCenterX(candidate),
      ) - handCenterX,
    );
    if (
      !best ||
      bottom > bestBottom ||
      (bottom === bestBottom &&
        (horizontal < bestHorizontal ||
          (horizontal === bestHorizontal && candidate.index < best.index)))
    ) {
      best = candidate;
      bestBottom = bottom;
      bestHorizontal = horizontal;
    }
  }
  return best;
}

function chooseNextHold(
  current: TerminalRow,
  holds: readonly TerminalRow[],
  handCenterX: number,
  rowHeight: number,
): TerminalRow | undefined {
  const maximumReach = Math.max(96, 6 * rowHeight);
  const currentY = attachmentHandY(current);
  let best: TerminalRow | undefined;
  let bestVertical = Number.POSITIVE_INFINITY;
  let bestHorizontal = Number.POSITIVE_INFINITY;

  for (const candidate of holds) {
    if (candidate.key === current.key || !isUsableClimberHold(candidate)) continue;
    const verticalGap = currentY - attachmentHandY(candidate);
    const horizontalGap = Math.abs(
      clamp(
        handCenterX,
        minimumHandCenterX(candidate),
        maximumHandCenterX(candidate),
      ) - handCenterX,
    );
    if (
      verticalGap <= 0 ||
      verticalGap > 4 * rowHeight ||
      horizontalGap > maximumReach
    ) {
      continue;
    }
    if (
      !best ||
      verticalGap < bestVertical ||
      (verticalGap === bestVertical &&
        (horizontalGap < bestHorizontal ||
          (horizontalGap === bestHorizontal && candidate.index < best.index)))
    ) {
      best = candidate;
      bestVertical = verticalGap;
      bestHorizontal = horizontalGap;
    }
  }
  return best;
}

function startTravel(
  model: ClimberMotionModel,
  kind: Travel['kind'],
  target: TerminalRow,
  duration: number,
): void {
  const handCenterX = model.x + HAND_CENTER_OFFSET_X;
  model.targetKey = target.key;
  model.travel = {
    kind,
    targetKey: target.key,
    startX: model.x,
    startY: model.y,
    targetHandX: clamp(
      handCenterX,
      minimumHandCenterX(target),
      maximumHandCenterX(target),
    ),
    targetHandY: attachmentHandY(target),
    elapsed: 0,
    duration,
  };
  setMotionState(model, kind === 'launch' ? 'launching' : 'climbing');
}

/**
 * Deterministic, DOM-free motion reducer. It mutates and returns the caller-owned
 * model so the browser animation loop does not allocate a state graph each frame.
 */
export function reduceClimberMotion(
  model: ClimberMotionModel,
  environment: ClimberMotionEnvironment,
  elapsedSeconds: number,
): ClimberMotionModel {
  const dt = clamp(elapsedSeconds, 0, MAX_FRAME_DELTA);
  if (model.state === 'paused' || dt === 0) return model;

  const holds = environment.holds;
  const cachedMedianRowHeight =
    environment.medianRowHeight ?? medianRowHeight(holds);
  const floorY = Math.max(0, model.displayHeight - SPRITE_HEIGHT);

  if (
    model.holdFollow &&
    (model.state === 'hanging' || model.state === 'shimmying')
  ) {
    const follow = model.holdFollow;
    follow.elapsed = Math.min(follow.duration, follow.elapsed + dt);
    const progress = follow.duration > 0 ? follow.elapsed / follow.duration : 1;
    model.x = follow.startX + (follow.targetX - follow.startX) * progress;
    model.y = follow.startY + (follow.targetY - follow.startY) * progress;
    if (progress < 1) return model;
    model.holdFollow = null;
  }

  switch (model.state) {
    case 'grounded': {
      model.y = floorY;
      model.vx = 0;
      model.vy = 0;
      const lowest = chooseLowestHold(holds, model.x + HAND_CENTER_OFFSET_X);
      if (!lowest) {
        model.x += model.paceDirection * PACE_SPEED * dt;
        if (model.x <= 0 || model.x >= model.displayWidth - SPRITE_WIDTH) {
          model.x = clamp(model.x, 0, Math.max(0, model.displayWidth - SPRITE_WIDTH));
          model.paceDirection = model.paceDirection === 1 ? -1 : 1;
        }
        break;
      }

      const launchHandX = clamp(
        model.x + HAND_CENTER_OFFSET_X,
        minimumHandCenterX(lowest),
        maximumHandCenterX(lowest),
      );
      const launchX = launchHandX - HAND_CENTER_OFFSET_X;
      model.x = moveToward(model.x, launchX, SHIMMY_SPEED * dt);
      if (model.x === launchX) {
        startTravel(model, 'launch', lowest, LAUNCH_DURATION);
      }
      break;
    }

    case 'launching':
    case 'climbing': {
      const travel = model.travel;
      const target = rowByKey(holds, travel?.targetKey ?? null);
      if (!travel || !target) {
        beginFall(model);
        break;
      }

      travel.elapsed = Math.min(travel.duration, travel.elapsed + dt);
      travel.targetHandX = clamp(
        travel.targetHandX,
        minimumHandCenterX(target),
        maximumHandCenterX(target),
      );
      travel.targetHandY = attachmentHandY(target);
      const progress = smoothstep(travel.elapsed / travel.duration);
      model.x =
        travel.startX +
        (travel.targetHandX - HAND_CENTER_OFFSET_X - travel.startX) * progress;
      model.y =
        travel.startY +
        (travel.targetHandY - HAND_OFFSET_Y - travel.startY) * progress;
      if (travel.elapsed >= travel.duration) attachToRow(model, target);
      break;
    }

    case 'hanging': {
      const current = rowByKey(holds, model.attachedKey);
      if (!current) {
        beginFall(model);
        break;
      }
      const handCenterX = clamp(
        model.x + HAND_CENTER_OFFSET_X,
        minimumHandCenterX(current),
        maximumHandCenterX(current),
      );
      model.x = handCenterX - HAND_CENTER_OFFSET_X;
      model.y = attachmentHandY(current) - HAND_OFFSET_Y;
      const next = chooseNextHold(
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
      );
      if (!next) break;

      model.targetKey = next.key;
      const targetHandCenterX = clamp(
        handCenterX,
        minimumHandCenterX(next),
        maximumHandCenterX(next),
      );
      const shimmyHandCenterX = clamp(
        targetHandCenterX,
        minimumHandCenterX(current),
        maximumHandCenterX(current),
      );
      if (Math.abs(shimmyHandCenterX - handCenterX) > 1) {
        setMotionState(model, 'shimmying');
      } else {
        startTravel(model, 'climb', next, CLIMB_DURATION);
      }
      break;
    }

    case 'shimmying': {
      const current = rowByKey(holds, model.attachedKey);
      const target = rowByKey(holds, model.targetKey);
      if (!current || !target) {
        beginFall(model);
        break;
      }
      const handCenterX = clamp(
        model.x + HAND_CENTER_OFFSET_X,
        minimumHandCenterX(current),
        maximumHandCenterX(current),
      );
      const targetHandCenterX = clamp(
        handCenterX,
        minimumHandCenterX(target),
        maximumHandCenterX(target),
      );
      const shimmyHandCenterX = clamp(
        targetHandCenterX,
        minimumHandCenterX(current),
        maximumHandCenterX(current),
      );
      const nextHandCenterX = moveToward(
        handCenterX,
        shimmyHandCenterX,
        SHIMMY_SPEED * dt,
      );
      model.x = nextHandCenterX - HAND_CENTER_OFFSET_X;
      model.y = attachmentHandY(current) - HAND_OFFSET_Y;
      if (nextHandCenterX === shimmyHandCenterX) {
        startTravel(model, 'climb', target, CLIMB_DURATION);
      }
      break;
    }

    case 'falling': {
      model.vy = Math.min(MAX_FALL_SPEED, model.vy + GRAVITY * dt);
      model.x += model.vx * dt;
      model.y += model.vy * dt;
      const maximumX = Math.max(0, model.displayWidth - SPRITE_WIDTH);
      if (model.x < 0 || model.x > maximumX) {
        model.x = clamp(model.x, 0, maximumX);
        model.vx *= -0.25;
      }
      if (model.y >= floorY) {
        model.y = floorY;
        model.vx = 0;
        model.vy = 0;
        setMotionState(model, 'landing');
      }
      break;
    }

    case 'landing':
      model.y = floorY;
      model.phaseElapsed += dt;
      if (model.phaseElapsed >= LANDING_RECOVERY) {
        setMotionState(model, 'grounded');
      }
      break;

  }

  return model;
}

function segmentIntersectsRect(start: Point, end: Point, rect: Rect): boolean {
  let minimum = 0;
  let maximum = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const checks: Array<[number, number]> = [
    [-dx, start.x - rect.x],
    [dx, rect.x + rect.width - start.x],
    [-dy, start.y - rect.y],
    [dy, rect.y + rect.height - start.y],
  ];

  for (const [direction, distance] of checks) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

export function selectClimberSpriteCell(
  state: ClimberState,
  timestamp: number,
  bumped: boolean,
  reducedMotion: boolean,
): number {
  if (bumped) return 23;
  const frame = reducedMotion ? 0 : Math.floor(timestamp / 140);
  switch (state) {
    case 'hanging':
    case 'shimmying':
      return frame % 8;
    case 'climbing':
      return 8 + (frame % 4);
    case 'launching':
      return 12 + (frame % 2);
    case 'falling':
      return reducedMotion
        ? 14
        : frame % 4 < 2
          ? 14 + (frame % 2)
          : 16 + (frame % 2);
    case 'landing':
      return 18 + (frame % 3);
    case 'paused':
    case 'grounded':
      return 21 + (frame % 2);
  }
}

function isAttachedState(state: ClimberState): boolean {
  return (
    state === 'launching' ||
    state === 'hanging' ||
    state === 'shimmying' ||
    state === 'climbing'
  );
}

export class ClimberSimulation {
  readonly #canvas: HTMLCanvasElement | null;
  readonly #context: CanvasRenderingContext2D | null;
  readonly #clock: () => number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #onStateChange?: (state: ClimberObservableState) => void;
  readonly #resizeObserver: ResizeObserverLike | null;
  readonly #motion: ClimberMotionModel;
  readonly #motionEnvironment: ClimberMotionEnvironment = {
    holds: EMPTY_HOLDS,
    medianRowHeight: 16,
  };
  readonly #inactiveEnvironment: ClimberMotionEnvironment = {
    holds: EMPTY_HOLDS,
    medianRowHeight: 16,
  };
  #snapshot: TerminalSnapshot | null = null;
  #backendStatus: TerminalBackendStatus = 'initializing';
  #statusInterruptedAt: number | null = null;
  #statusReleaseHandled = false;
  #lastPointer: { point: Point; timestamp: number } | null = null;
  #sprite: CanvasImageSource | null = null;
  #spriteLoaded = false;
  #frameHandle: number | null = null;
  #lastFrameTimestamp: number | null = null;
  #destroyed = false;
  #bumpUntil = 0;
  #lastObservedState: ClimberState;
  #lastObservedHoldCount = -1;
  #devicePixelRatio = 1;
  #reducedMotion = false;
  #motionPreference: MediaQueryList | null = null;
  readonly #handleMotionPreference = (event: MediaQueryListEvent): void => {
    this.#reducedMotion = event.matches;
  };
  readonly #onAnimationFrame = (timestamp: number): void => {
    this.#frameHandle = null;
    this.#frame(timestamp);
    this.#scheduleFrame();
  };

  constructor(options: ClimberSimulationOptions) {
    this.#canvas = options.canvas;
    this.#context = options.canvas?.getContext('2d') ?? null;
    this.#clock = options.clock ?? (() => performance.now());
    this.#onStateChange = options.onStateChange;
    if (options.reducedMotion !== undefined) {
      this.#reducedMotion = options.reducedMotion;
    } else if (typeof matchMedia !== 'undefined') {
      this.#motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
      this.#reducedMotion = this.#motionPreference.matches;
      this.#motionPreference.addEventListener(
        'change',
        this.#handleMotionPreference,
      );
    }

    const nativeRequest = globalThis.requestAnimationFrame?.bind(globalThis);
    const nativeCancel = globalThis.cancelAnimationFrame?.bind(globalThis);
    if (!options.requestAnimationFrame && !nativeRequest) {
      throw new Error('A requestAnimationFrame implementation is required headlessly');
    }
    if (!options.cancelAnimationFrame && !nativeCancel) {
      throw new Error('A cancelAnimationFrame implementation is required headlessly');
    }
    this.#requestFrame = options.requestAnimationFrame ?? nativeRequest!;
    this.#cancelFrame = options.cancelAnimationFrame ?? nativeCancel!;

    const initialWidth = Math.max(
      1,
      options.displaySize?.width ?? options.canvas?.clientWidth ?? 1,
    );
    const initialHeight = Math.max(
      1,
      options.displaySize?.height ?? options.canvas?.clientHeight ?? 1,
    );
    this.#motion = {
      state: 'grounded',
      resumeState: 'grounded',
      x: Math.max(0, (initialWidth - SPRITE_WIDTH) / 2),
      y: Math.max(0, initialHeight - SPRITE_HEIGHT),
      vx: 0,
      vy: 0,
      displayWidth: initialWidth,
      displayHeight: initialHeight,
      paceDirection: 1,
      attachedKey: null,
      targetKey: null,
      phaseElapsed: 0,
      travel: null,
      holdFollow: null,
    };
    this.#lastObservedState = this.#motion.state;

    if (options.spriteImage) {
      this.#sprite = options.spriteImage;
      this.#spriteLoaded = true;
    } else if (typeof Image !== 'undefined') {
      const image = new Image();
      image.addEventListener('load', () => {
        this.#spriteLoaded = true;
      });
      image.src =
        options.spriteUrl ??
        new URL('./assets/climber-sprites.svg', import.meta.url).href;
      this.#sprite = image;
    }

    const createObserver =
      options.createResizeObserver ??
      (typeof ResizeObserver !== 'undefined'
        ? (callback: ResizeObserverCallback) => new ResizeObserver(callback)
        : undefined);
    this.#resizeObserver =
      this.#canvas && createObserver
        ? createObserver(() => this.#resizeCanvas())
        : null;
    this.#resizeObserver?.observe(this.#canvas!);
    this.#resizeCanvas();

    if (options.autoStart !== false) this.#scheduleFrame();
    this.#notify(true);
  }

  get state(): ClimberState {
    return this.#motion.state;
  }

  get holdCount(): number {
    return this.#backendStatus === 'tracking' ||
      this.#backendStatus === 'paused'
      ? this.#motionEnvironment.holds.length
      : 0;
  }

  get position(): Readonly<Point> {
    return { x: this.#motion.x, y: this.#motion.y };
  }

  setTerminalSnapshot(snapshot: RendererTerminalSnapshot): void {
    if (this.#destroyed) return;
    const next = createTerminalSnapshot(snapshot);
    const previous = this.#snapshot;
    const trackedKey =
      this.#motion.attachedKey ?? this.#motion.travel?.targetKey ?? null;
    const reconciliation = reconcileRows(previous, next, trackedKey);
    const displayChanged = Boolean(
      previous && previous.displayId !== next.displayId,
    );

    this.#snapshot = next;
    const usableHolds = getAttachableRows(next).filter(isUsableClimberHold);
    this.#motionEnvironment.holds = usableHolds;
    this.#motionEnvironment.medianRowHeight = medianRowHeight(usableHolds);
    this.#motion.displayWidth = Math.max(1, next.displayBounds.width);
    this.#motion.displayHeight = Math.max(1, next.displayBounds.height);
    this.#backendStatus = 'tracking';
    this.#statusInterruptedAt = null;
    this.#statusReleaseHandled = false;

    if (reconciliation.targetChanged || displayChanged) {
      this.reset();
      return;
    }

    if (reconciliation.attachedExitedTop) {
      this.#motion.x = clamp(
        this.#motion.x,
        0,
        Math.max(0, this.#motion.displayWidth - SPRITE_WIDTH),
      );
      this.#motion.y = -SPRITE_HEIGHT;
      this.#motion.vy = 0;
      beginFall(this.#motion, this.#motion.vx);
      this.#notify(true);
      return;
    }

    if (reconciliation.holdMovedTooFast) {
      beginFall(this.#motion);
      this.#notify(true);
      return;
    }

    if (!previous) {
      this.#notify(true);
      return;
    }

    const previousAttachedKey = this.#motion.attachedKey;
    if (previousAttachedKey) {
      const mapped = reconciliation.keyMappings.get(previousAttachedKey);
      if (!mapped) {
        beginFall(this.#motion);
        this.#notify(true);
        return;
      }
      const oldRow = previous.rows.find((row) => row.key === previousAttachedKey);
      const newRow = rowByKey(this.#motionEnvironment.holds, mapped);
      if (!newRow) {
        beginFall(this.#motion);
        this.#notify(true);
        return;
      }
      this.#motion.attachedKey = mapped;
      if (oldRow) {
        const oldHandCenterX = clamp(
          this.#motion.x + HAND_CENTER_OFFSET_X,
          minimumHandCenterX(oldRow),
          maximumHandCenterX(oldRow),
        );
        const translatedHandCenterX =
          oldHandCenterX +
          (newRow.rect.x +
            newRow.rect.width / 2 -
            (oldRow.rect.x + oldRow.rect.width / 2));
        const targetHandCenterX = clamp(
          translatedHandCenterX,
          minimumHandCenterX(newRow),
          maximumHandCenterX(newRow),
        );
        const startHandCenterX = clamp(
          oldHandCenterX,
          minimumHandCenterX(newRow),
          maximumHandCenterX(newRow),
        );
        const oldHandY = this.#motion.y + HAND_OFFSET_Y;
        const startHandY = clamp(
          oldHandY,
          newRow.rect.y + HOLD_INSET,
          newRow.rect.y + newRow.rect.height - HOLD_INSET,
        );
        this.#motion.x = startHandCenterX - HAND_CENTER_OFFSET_X;
        this.#motion.y = startHandY - HAND_OFFSET_Y;
        this.#motion.holdFollow = {
          startX: this.#motion.x,
          startY: this.#motion.y,
          targetX: targetHandCenterX - HAND_CENTER_OFFSET_X,
          targetY: attachmentHandY(newRow) - HAND_OFFSET_Y,
          elapsed: 0,
          duration: clamp(
            (next.sampledAt - previous.sampledAt) / 1000,
            0.016,
            0.15,
          ),
        };
      }
    }

    if (this.#motion.targetKey) {
      const mappedTarget = reconciliation.keyMappings.get(this.#motion.targetKey);
      if (
        !mappedTarget ||
        !rowByKey(this.#motionEnvironment.holds, mappedTarget)
      ) {
        beginFall(this.#motion);
        this.#notify(true);
        return;
      }
      this.#motion.targetKey = mappedTarget;
      if (this.#motion.travel) {
        this.#motion.travel.targetKey = mappedTarget;
      }
    } else if (this.#motion.travel) {
      const mappedTarget = reconciliation.keyMappings.get(
        this.#motion.travel.targetKey,
      );
      if (
        !mappedTarget ||
        !rowByKey(this.#motionEnvironment.holds, mappedTarget)
      ) {
        beginFall(this.#motion);
        this.#notify(true);
        return;
      }
      this.#motion.travel.targetKey = mappedTarget;
    }

    this.#notify(true);
  }

  setTerminalStatus(status: TerminalBackendStatus): void {
    if (this.#destroyed) return;
    if (status === 'paused') {
      this.setPaused(true);
      return;
    }

    this.#backendStatus = status;
    if (status === 'tracking') {
      this.#statusInterruptedAt = null;
      this.#statusReleaseHandled = false;
    } else if (this.#statusInterruptedAt === null) {
      this.#statusInterruptedAt = this.#clock();
      this.#statusReleaseHandled = false;
    }
  }

  handlePointerMove(point: Point, timestamp: number): void {
    if (this.#destroyed || !Number.isFinite(timestamp)) return;
    const previous = this.#lastPointer;
    this.#lastPointer = { point: { ...point }, timestamp };
    if (!previous || this.#motion.state === 'paused') return;

    const elapsedSeconds = (timestamp - previous.timestamp) / 1000;
    if (elapsedSeconds <= 0) return;
    const dx = point.x - previous.point.x;
    const dy = point.y - previous.point.y;
    const speed = Math.hypot(dx, dy) / elapsedSeconds;
    const hitbox: Rect = {
      x: this.#motion.x - HITBOX_PADDING,
      y: this.#motion.y - HITBOX_PADDING,
      width: SPRITE_WIDTH + HITBOX_PADDING * 2,
      height: SPRITE_HEIGHT + HITBOX_PADDING * 2,
    };
    if (!segmentIntersectsRect(previous.point, point, hitbox)) return;

    if (speed >= POINTER_BUMP_SPEED && isAttachedState(this.#motion.state)) {
      const cursorVx = dx / elapsedSeconds;
      beginFall(this.#motion, clamp(cursorVx * 0.35, -500, 500));
      this.#notify(true);
    } else if (speed < POINTER_BUMP_SPEED) {
      this.#bumpUntil = this.#clock() + 160;
    }
  }

  setPaused(paused: boolean): void {
    if (this.#destroyed || paused === (this.#motion.state === 'paused')) return;
    if (paused) {
      this.#motion.resumeState =
        this.#motion.state === 'paused' ? 'grounded' : this.#motion.state;
      this.#motion.state = 'paused';
      this.#backendStatus = 'paused';
    } else {
      this.#motion.state = this.#motion.resumeState;
      if (this.#backendStatus === 'paused') {
        this.#backendStatus = this.#snapshot ? 'tracking' : 'initializing';
      }
      this.#lastFrameTimestamp = null;
    }
    this.#notify(true);
  }

  reset(): void {
    if (this.#destroyed) return;
    this.#motion.x = clamp(
      this.#motion.x,
      0,
      Math.max(0, this.#motion.displayWidth - SPRITE_WIDTH),
    );
    this.#motion.y = Math.max(0, this.#motion.displayHeight - SPRITE_HEIGHT);
    this.#motion.vx = 0;
    this.#motion.vy = 0;
    this.#motion.attachedKey = null;
    this.#motion.targetKey = null;
    this.#motion.travel = null;
    this.#motion.holdFollow = null;
    this.#motion.phaseElapsed = 0;
    this.#motion.state = 'grounded';
    this.#motion.resumeState = 'grounded';
    this.#lastPointer = null;
    this.#notify(true);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#frameHandle !== null) {
      this.#cancelFrame(this.#frameHandle);
      this.#frameHandle = null;
    }
    this.#resizeObserver?.disconnect();
    this.#motionPreference?.removeEventListener(
      'change',
      this.#handleMotionPreference,
    );
    this.#snapshot = null;
    this.#motionEnvironment.holds = EMPTY_HOLDS;
    this.#lastPointer = null;
  }

  #scheduleFrame(): void {
    if (this.#destroyed || this.#frameHandle !== null) return;
    this.#frameHandle = this.#requestFrame(this.#onAnimationFrame);
  }

  #frame(timestamp: number): void {
    const elapsed =
      this.#lastFrameTimestamp === null
        ? 1 / 60
        : (timestamp - this.#lastFrameTimestamp) / 1000;
    this.#lastFrameTimestamp = timestamp;

    let frozenForGrace = false;
    if (
      this.#backendStatus !== 'tracking' &&
      this.#backendStatus !== 'paused' &&
      this.#statusInterruptedAt !== null
    ) {
      const interruption = this.#clock() - this.#statusInterruptedAt;
      frozenForGrace = interruption < STATUS_GRACE_MS;
      if (!frozenForGrace && !this.#statusReleaseHandled) {
        this.#statusReleaseHandled = true;
        if (isAttachedState(this.#motion.state)) beginFall(this.#motion);
      }
    }

    if (!frozenForGrace) {
      reduceClimberMotion(
        this.#motion,
        this.#backendStatus === 'tracking'
          ? this.#motionEnvironment
          : this.#inactiveEnvironment,
        elapsed,
      );
    }
    this.#render(timestamp);
    this.#notify(false);
  }

  #resizeCanvas(): void {
    if (!this.#canvas || !this.#context) return;
    const bounds = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, bounds.width || this.#canvas.clientWidth || 1);
    const height = Math.max(1, bounds.height || this.#canvas.clientHeight || 1);
    const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    this.#devicePixelRatio = ratio;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (this.#canvas.width !== pixelWidth) this.#canvas.width = pixelWidth;
    if (this.#canvas.height !== pixelHeight) this.#canvas.height = pixelHeight;
    this.#context.imageSmoothingEnabled = false;
  }

  #render(timestamp: number): void {
    if (!this.#context || !this.#canvas) return;
    const context = this.#context;
    const ratio = this.#devicePixelRatio;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = false;

    const cell = selectClimberSpriteCell(
      this.#motion.state,
      timestamp,
      this.#bumpUntil > this.#clock(),
      this.#reducedMotion,
    );
    const column = cell % 8;
    const row = Math.floor(cell / 8);
    if (this.#sprite && this.#spriteLoaded) {
      context.drawImage(
        this.#sprite,
        column * 48,
        row * 48,
        48,
        48,
        Math.round(this.#motion.x),
        Math.round(this.#motion.y),
        SPRITE_WIDTH,
        SPRITE_HEIGHT,
      );
      return;
    }

    // A quiet fallback while the atlas decodes; it is replaced, not animated.
    context.fillStyle = '#e3a62f';
    context.fillRect(
      Math.round(this.#motion.x + 9),
      Math.round(this.#motion.y + 13),
      22,
      25,
    );
    context.fillStyle = '#e8dfc5';
    context.fillRect(
      Math.round(this.#motion.x + 11),
      Math.round(this.#motion.y + 2),
      18,
      13,
    );
    context.fillStyle = '#123c43';
    context.fillRect(
      Math.round(this.#motion.x + 10),
      Math.round(this.#motion.y + 38),
      8,
      14,
    );
    context.fillRect(
      Math.round(this.#motion.x + 22),
      Math.round(this.#motion.y + 38),
      8,
      14,
    );
  }

  #notify(force: boolean): void {
    const holdCount = this.holdCount;
    if (
      !force &&
      this.#lastObservedState === this.#motion.state &&
      this.#lastObservedHoldCount === holdCount
    ) {
      return;
    }
    this.#lastObservedState = this.#motion.state;
    this.#lastObservedHoldCount = holdCount;
    this.#onStateChange?.({
      state: this.#motion.state,
      holdCount,
      position: { x: this.#motion.x, y: this.#motion.y },
    });
  }
}
