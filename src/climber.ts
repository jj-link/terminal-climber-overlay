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
  | 'summiting'
  | 'planting'
  | 'camped'
  | 'packing'
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
  summitStableElapsed: number;
  targetSnapshotCount: number;
  routeSearchAboveY: number;
  routeRetryElapsed: number;
  summitStartY: number;
  flagKey: string | null;
  flagAnchorRatio: number;
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
export const TARGET_CONFIRM_SNAPSHOTS = 3;
export const ROUTE_RETRY_DURATION = 1.5;
export const SUMMIT_STABILITY_DURATION = 1.2;
export const SUMMIT_MANTLE_DURATION = 0.55;
export const FLAG_PLANT_DURATION = 0.8;
export const CAMP_PACK_DURATION = 0.45;

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

function campBodyY(row: TerminalRow): number {
  return Math.max(0, row.rect.y - SPRITE_HEIGHT + HOLD_INSET);
}

function flagAnchorRatio(row: TerminalRow, bodyCenterX: number): number {
  const rowCenterX = row.rect.x + row.rect.width / 2;
  const side = bodyCenterX <= rowCenterX ? 1 : -1;
  const anchorX = clamp(
    bodyCenterX + side * (SPRITE_WIDTH / 2 + 10),
    row.rect.x + HOLD_INSET,
    row.rect.x + row.rect.width - HOLD_INSET,
  );
  return (anchorX - row.rect.x) / row.rect.width;
}

function isSummitState(state: ClimberState): boolean {
  return (
    state === 'summiting' ||
    state === 'planting' ||
    state === 'camped' ||
    state === 'packing'
  );
}

function followsAttachedRow(state: ClimberState): boolean {
  return state === 'hanging' || state === 'shimmying' || isSummitState(state);
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
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
  model.routeSearchAboveY = Number.POSITIVE_INFINITY;
  model.routeRetryElapsed = 0;
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
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
  model.routeSearchAboveY = Number.POSITIVE_INFINITY;
  model.routeRetryElapsed = 0;
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
  searchAboveY = Number.POSITIVE_INFINITY,
): TerminalRow | undefined {
  const maximumReach = Math.max(96, 6 * rowHeight);
  const currentY = attachmentHandY(current);
  const currentMinimumX = minimumHandCenterX(current);
  const currentMaximumX = maximumHandCenterX(current);
  let best: TerminalRow | undefined;
  let bestVertical = Number.POSITIVE_INFINITY;
  let bestHorizontal = Number.POSITIVE_INFINITY;

  for (const candidate of holds) {
    if (candidate.key === current.key || !isUsableClimberHold(candidate)) continue;
    const candidateY = attachmentHandY(candidate);
    if (candidateY >= searchAboveY) continue;
    const verticalGap = currentY - candidateY;
    const candidateMinimumX = minimumHandCenterX(candidate);
    const candidateMaximumX = maximumHandCenterX(candidate);
    const horizontalMovement = Math.abs(
      clamp(handCenterX, candidateMinimumX, candidateMaximumX) - handCenterX,
    );
    const reachGap =
      candidateMinimumX > currentMaximumX
        ? candidateMinimumX - currentMaximumX
        : candidateMaximumX < currentMinimumX
          ? currentMinimumX - candidateMaximumX
          : 0;
    if (
      verticalGap <= 0 ||
      verticalGap > 4 * rowHeight ||
      reachGap > maximumReach
    ) {
      continue;
    }
    if (
      !best ||
      verticalGap < bestVertical ||
      (verticalGap === bestVertical &&
        (horizontalMovement < bestHorizontal ||
          (horizontalMovement === bestHorizontal &&
            (candidate.index < best.index ||
              (candidate.index === best.index &&
                candidate.segmentIndex < best.segmentIndex)))))
    ) {
      best = candidate;
      bestVertical = verticalGap;
      bestHorizontal = horizontalMovement;
    }
  }
  return best;
}

function hasUsableHoldAbove(
  current: TerminalRow,
  holds: readonly TerminalRow[],
): boolean {
  const currentY = attachmentHandY(current);
  for (const candidate of holds) {
    if (
      candidate.key !== current.key &&
      isUsableClimberHold(candidate) &&
      attachmentHandY(candidate) < currentY - 0.5
    ) {
      return true;
    }
  }
  return false;
}

function hasConfirmedNextHold(
  model: ClimberMotionModel,
  next: TerminalRow | undefined,
): next is TerminalRow {
  if (!next) {
    model.targetKey = null;
    model.targetSnapshotCount = 0;
    return false;
  }
  if (model.targetKey !== next.key) {
    model.targetKey = next.key;
    model.targetSnapshotCount = 1;
    return false;
  }
  return model.targetSnapshotCount >= TARGET_CONFIRM_SNAPSHOTS;
}


function startTravel(
  model: ClimberMotionModel,
  kind: Travel['kind'],
  target: TerminalRow,
  duration: number,
): void {
  const targetHandX = clamp(
    model.x + HAND_CENTER_OFFSET_X,
    minimumHandCenterX(target),
    maximumHandCenterX(target),
  );
  model.targetKey = target.key;
  model.travel = {
    kind,
    targetKey: target.key,
    startX: model.x,
    startY: model.y,
    targetHandX,
    targetHandY: attachmentHandY(target),
    elapsed: 0,
    duration,
  };
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
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

  if (model.holdFollow && followsAttachedRow(model.state)) {
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
      if (Number.isFinite(model.routeSearchAboveY)) {
        model.routeRetryElapsed += dt;
        if (model.routeRetryElapsed >= ROUTE_RETRY_DURATION) {
          model.routeSearchAboveY = Number.POSITIVE_INFINITY;
          model.routeRetryElapsed = 0;
        }
      }
      const next = chooseNextHold(
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
        model.routeSearchAboveY,
      );
      if (!hasConfirmedNextHold(model, next)) {
        if (hasUsableHoldAbove(current, holds)) {
          model.summitStableElapsed = 0;
        } else {
          model.summitStableElapsed += dt;
          if (model.summitStableElapsed >= SUMMIT_STABILITY_DURATION) {
            model.summitStartY = model.y;
            setMotionState(model, 'summiting');
          }
        }
        break;
      }

      model.summitStableElapsed = 0;
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
      if (!current) {
        beginFall(model);
        break;
      }
      if (!target) {
        model.targetKey = null;
        model.targetSnapshotCount = 0;
        setMotionState(model, 'hanging');
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

    case 'summiting': {
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
      const next = chooseNextHold(
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
      );
      if (hasConfirmedNextHold(model, next)) {
        setMotionState(model, 'packing');
        break;
      }
      model.phaseElapsed = Math.min(
        SUMMIT_MANTLE_DURATION,
        model.phaseElapsed + dt,
      );
      const progress = smoothstep(
        model.phaseElapsed / SUMMIT_MANTLE_DURATION,
      );
      model.x = handCenterX - HAND_CENTER_OFFSET_X;
      model.y =
        model.summitStartY +
        (campBodyY(current) - model.summitStartY) * progress;
      if (model.phaseElapsed >= SUMMIT_MANTLE_DURATION) {
        setMotionState(
          model,
          model.flagKey === current.key ? 'camped' : 'planting',
        );
      }
      break;
    }

    case 'planting': {
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
      const next = chooseNextHold(
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
      );
      if (hasConfirmedNextHold(model, next)) {
        setMotionState(model, 'packing');
        break;
      }
      model.x = handCenterX - HAND_CENTER_OFFSET_X;
      model.y = campBodyY(current);
      model.phaseElapsed = Math.min(
        FLAG_PLANT_DURATION,
        model.phaseElapsed + dt,
      );
      if (model.phaseElapsed >= FLAG_PLANT_DURATION) {
        model.flagKey = current.key;
        model.flagAnchorRatio = flagAnchorRatio(
          current,
          model.x + HAND_CENTER_OFFSET_X,
        );
        setMotionState(model, 'camped');
      }
      break;
    }

    case 'camped': {
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
      model.y = campBodyY(current);
      const next = chooseNextHold(
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
      );
      if (hasConfirmedNextHold(model, next)) {
        setMotionState(model, 'packing');
      }
      break;
    }

    case 'packing': {
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
      const next = chooseNextHold(
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
      );
      if (!next) {
        model.targetKey = null;
        setMotionState(
          model,
          model.flagKey === current.key ? 'camped' : 'planting',
        );
        break;
      }
      model.targetKey = next.key;
      model.x = handCenterX - HAND_CENTER_OFFSET_X;
      model.y = campBodyY(current);
      model.phaseElapsed = Math.min(
        CAMP_PACK_DURATION,
        model.phaseElapsed + dt,
      );
      if (model.phaseElapsed >= CAMP_PACK_DURATION) {
        if (model.flagKey === current.key) model.flagKey = null;
        model.targetKey = null;
        model.y = attachmentHandY(current) - HAND_OFFSET_Y;
        model.summitStableElapsed = 0;
        setMotionState(model, 'hanging');
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
    case 'summiting':
      return 24 + (frame % 2);
    case 'planting':
      return 26 + (frame % 2);
    case 'camped':
      return reducedMotion ? 28 : 28 + (frame % 3);
    case 'packing':
      return 31;
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
    state === 'climbing' ||
    isSummitState(state)
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
      summitStableElapsed: 0,
      targetSnapshotCount: 0,
      routeSearchAboveY: Number.POSITIVE_INFINITY,
      routeRetryElapsed: 0,
      summitStartY: 0,
      flagKey: null,
      flagAnchorRatio: 0.84,
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

  get hasFlag(): boolean {
    return this.#motion.flagKey !== null;
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

    if (this.#motion.flagKey) {
      const mappedFlag = reconciliation.keyMappings.get(this.#motion.flagKey);
      this.#motion.flagKey =
        mappedFlag && rowByKey(this.#motionEnvironment.holds, mappedFlag)
          ? mappedFlag
          : null;
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
        const rowDeltaX =
          newRow.rect.x +
          newRow.rect.width / 2 -
          (oldRow.rect.x + oldRow.rect.width / 2);
        const rowDeltaY = newRow.rect.y - oldRow.rect.y;
        const followDuration = clamp(
          (next.sampledAt - previous.sampledAt) / 1000,
          0.016,
          0.15,
        );
        if (this.#motion.state === 'hanging') {
          if (Math.abs(rowDeltaX) > 0.5 || Math.abs(rowDeltaY) > 0.5) {
            this.#motion.summitStableElapsed = 0;
            this.#motion.routeSearchAboveY = Number.POSITIVE_INFINITY;
            this.#motion.routeRetryElapsed = 0;
          }
          const oldHandCenterX = clamp(
            this.#motion.x + HAND_CENTER_OFFSET_X,
            minimumHandCenterX(oldRow),
            maximumHandCenterX(oldRow),
          );
          const targetHandCenterX = clamp(
            oldHandCenterX + rowDeltaX,
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
          const targetX = targetHandCenterX - HAND_CENTER_OFFSET_X;
          const targetY = attachmentHandY(newRow) - HAND_OFFSET_Y;
          if (
            Math.abs(targetX - this.#motion.x) > 0.25 ||
            Math.abs(targetY - this.#motion.y) > 0.25
          ) {
            this.#motion.holdFollow = {
              startX: this.#motion.x,
              startY: this.#motion.y,
              targetX,
              targetY,
              elapsed: 0,
              duration: followDuration,
            };
          } else {
            this.#motion.holdFollow = null;
          }
        } else if (isSummitState(this.#motion.state)) {
          if (this.#motion.state === 'summiting') {
            this.#motion.summitStartY += rowDeltaY;
          }
          const targetX = clamp(
            this.#motion.x + rowDeltaX,
            minimumHandCenterX(newRow) - HAND_CENTER_OFFSET_X,
            maximumHandCenterX(newRow) - HAND_CENTER_OFFSET_X,
          );
          const targetY = this.#motion.y + rowDeltaY;
          if (
            Math.abs(targetX - this.#motion.x) > 0.25 ||
            Math.abs(targetY - this.#motion.y) > 0.25
          ) {
            this.#motion.holdFollow = {
              startX: this.#motion.x,
              startY: this.#motion.y,
              targetX,
              targetY,
              elapsed: 0,
              duration: followDuration,
            };
          } else {
            this.#motion.holdFollow = null;
          }
        }
      }
    }

    if (this.#motion.targetKey) {
      const previousTarget = previous.rows.find(
        (row) => row.key === this.#motion.targetKey,
      );
      const mappedTarget = reconciliation.keyMappings.get(this.#motion.targetKey);
      if (
        !mappedTarget ||
        !rowByKey(this.#motionEnvironment.holds, mappedTarget)
      ) {
        if (this.#motion.state === 'packing') {
          this.#motion.targetKey = null;
          setMotionState(
            this.#motion,
            this.#motion.flagKey === this.#motion.attachedKey
              ? 'camped'
              : 'planting',
          );
        } else if (
          this.#motion.state === 'hanging' ||
          this.#motion.state === 'shimmying' ||
          isSummitState(this.#motion.state)
        ) {
          this.#motion.targetKey = null;
          this.#motion.targetSnapshotCount = 0;
          if (
            previousTarget &&
            (this.#motion.state === 'hanging' ||
              this.#motion.state === 'shimmying')
          ) {
            this.#motion.routeSearchAboveY = Math.min(
              this.#motion.routeSearchAboveY,
              attachmentHandY(previousTarget) - 0.5,
            );
            this.#motion.routeRetryElapsed = 0;
          }
          if (this.#motion.state === 'shimmying') {
            setMotionState(this.#motion, 'hanging');
          }
        } else {
          beginFall(this.#motion);
          this.#notify(true);
          return;
        }
      } else {
        this.#motion.targetKey = mappedTarget;
        if (
          this.#motion.state === 'hanging' ||
          (isSummitState(this.#motion.state) &&
            this.#motion.state !== 'packing')
        ) {
          this.#motion.targetSnapshotCount += 1;
        }
        if (this.#motion.travel) {
          this.#motion.travel.targetKey = mappedTarget;
        }
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
    this.#motion.summitStableElapsed = 0;
    this.#motion.targetSnapshotCount = 0;
    this.#motion.routeSearchAboveY = Number.POSITIVE_INFINITY;
    this.#motion.routeRetryElapsed = 0;
    this.#motion.summitStartY = 0;
    this.#motion.flagKey = null;
    this.#motion.flagAnchorRatio = 0.84;
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

    this.#renderCampsite(context, timestamp);
    const pausedAtSummit =
      this.#motion.state === 'paused' && isSummitState(this.#motion.resumeState);
    const cell = selectClimberSpriteCell(
      pausedAtSummit ? this.#motion.resumeState : this.#motion.state,
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

  #renderCampsite(
    context: CanvasRenderingContext2D,
    timestamp: number,
  ): void {
    if (
      this.#backendStatus !== 'tracking' &&
      this.#backendStatus !== 'paused'
    ) {
      return;
    }
    const visualState =
      this.#motion.state === 'paused'
        ? this.#motion.resumeState
        : this.#motion.state;
    const plantedRow = rowByKey(
      this.#motionEnvironment.holds,
      this.#motion.flagKey,
    );
    const plantingRow =
      visualState === 'planting'
        ? rowByKey(
            this.#motionEnvironment.holds,
            this.#motion.attachedKey,
          )
        : undefined;
    const flagRow = plantedRow ?? plantingRow;
    if (flagRow) {
      let deployment = 1;
      if (visualState === 'planting' && !plantedRow) {
        deployment = clamp(
          this.#motion.phaseElapsed / FLAG_PLANT_DURATION,
          0,
          1,
        );
      } else if (
        visualState === 'packing' &&
        plantedRow?.key === this.#motion.attachedKey
      ) {
        deployment =
          1 -
          clamp(this.#motion.phaseElapsed / CAMP_PACK_DURATION, 0, 1);
      }
      if (deployment > 0) {
        const anchorRatio = plantedRow
          ? this.#motion.flagAnchorRatio
          : flagAnchorRatio(
              flagRow,
              this.#motion.x + HAND_CENTER_OFFSET_X,
            );
        const anchorX = Math.round(
          flagRow.rect.x + flagRow.rect.width * anchorRatio,
        );
        const baseY = Math.round(flagRow.rect.y + HOLD_INSET);
        const poleTopY = Math.round(baseY - 31 * deployment);
        context.fillStyle = '#101719';
        context.fillRect(anchorX - 2, poleTopY, 4, baseY - poleTopY + 2);
        context.fillStyle = '#eadfbd';
        context.fillRect(anchorX - 1, poleTopY + 1, 2, baseY - poleTopY);

        if (deployment > 0.28) {
          const unfurl = clamp((deployment - 0.28) / 0.72, 0, 1);
          const flutter =
            this.#reducedMotion || unfurl < 1
              ? 0
              : Math.floor(timestamp / 180) % 2;
          const flagWidth = Math.round(17 * unfurl);
          context.beginPath();
          context.moveTo(anchorX + 1, poleTopY + 2);
          context.lineTo(anchorX + 1 + flagWidth, poleTopY + 6 + flutter);
          context.lineTo(anchorX + 1, poleTopY + 12);
          context.closePath();
          context.fillStyle = '#dfa62d';
          context.fill();
          context.strokeStyle = '#101719';
          context.lineWidth = 2;
          context.stroke();
        }
      }
    }

    if (
      (visualState === 'planting' ||
        visualState === 'camped' ||
        visualState === 'packing') &&
      this.#motion.attachedKey
    ) {
      const row = rowByKey(
        this.#motionEnvironment.holds,
        this.#motion.attachedKey,
      );
      if (row) {
        const bodyCenterX = this.#motion.x + HAND_CENTER_OFFSET_X;
        const campsiteAnchorRatio =
          this.#motion.flagKey === row.key
            ? this.#motion.flagAnchorRatio
            : flagAnchorRatio(row, bodyCenterX);
        const flagIsRightOfClimber =
          row.rect.x + row.rect.width * campsiteAnchorRatio >= bodyCenterX;
        const gearX = Math.round(
          clamp(
            this.#motion.x +
              (flagIsRightOfClimber ? -5 : SPRITE_WIDTH - 7),
            row.rect.x,
            row.rect.x + row.rect.width - 12,
          ),
        );
        const gearY = Math.round(row.rect.y - 7);
        context.fillStyle = '#101719';
        context.fillRect(gearX - 1, gearY - 1, 14, 7);
        context.fillStyle = '#16504d';
        context.fillRect(gearX, gearY, 12, 5);
        context.fillStyle = '#d7c693';
        context.fillRect(gearX + 5, gearY, 2, 5);
      }
    }
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
