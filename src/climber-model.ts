import type { TerminalRow } from './row-tracker';

export type ClimberState =
  | 'grounded'
  | 'launching'
  | 'hanging'
  | 'shimmying'
  | 'climbing'
  | 'slipping'
  | 'grappling'
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

export type HandSide = 'left' | 'right';

export interface HandAnchor {
  key: string | null;
  x: number;
  y: number;
}

export interface HandSlip {
  side: HandSide;
  x: number;
  y: number;
  elapsed: number;
  duration: number;
  vx: number;
  vy: number;
}

export interface Travel {
  kind: 'launch' | 'climb';
  targetKey: string;
  leadHand: HandSide;
  trailingKey: string | null;
  startX: number;
  startY: number;
  startLeadX: number;
  startLeadY: number;
  targetBodyX: number;
  targetHandX: number;
  targetHandY: number;
  elapsed: number;
  duration: number;
}

export interface HoldFollow {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  handStart: { left: Point; right: Point };
  handTarget: { left: Point; right: Point };
  elapsed: number;
  duration: number;
}

/**
 * A one-shot grapple launched from a hang when the next usable text hold is
 * beyond normal hand-to-hand reach (a vertical gap). The rope only ever
 * latches onto a text hold — never empty space.
 */
export interface Grapple {
  targetKey: string;
  leadHand: HandSide;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  handStart: Point;
  handEnd: Point;
  anchorX: number;
  anchorY: number;
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
  leftHand: HandAnchor;
  rightHand: HandAnchor;
  slip: HandSlip | null;
  routePlanKeys: string[];
  phaseElapsed: number;
  travel: Travel | null;
  holdFollow: HoldFollow | null;
  grapple: Grapple | null;
  summitStableElapsed: number;
  targetSnapshotCount: number;
  routeSearchAboveY: number;
  routeRetryElapsed: number;
  summitStartY: number;
  flagKey: string | null;
  flagAnchorRatio: number;
}

export interface ClimberMotionEnvironment {
  /** Pre-filtered visible text spans that can hold at least one hand. */
  holds: readonly TerminalRow[];
  /** Cache this with the snapshot to avoid sorting in the animation loop. */
  medianRowHeight?: number;
}

export const SPRITE_WIDTH = 48;
export const SPRITE_HEIGHT = 48;
export const GRAVITY = 1900;
export const MAX_FALL_SPEED = 1450;
export const SHIMMY_SPEED = 92;
export const SLIP_DURATION = 0.28;
export const ROUTE_LOOKAHEAD_DEPTH = 3;
export const CLIMB_DURATION = 0.42;
export const LAUNCH_DURATION = 0.7;
/**
 * A single hand-to-hand climb step may rise at most about one row and reach a
 * few px sideways. Anything larger is a gap that must be traversed or grappled
 * — never leapt over.
 */
export const MAX_CLIMB_GAP_FACTOR = 1.3;
export const MAX_CLIMB_REACH = 24;
/**
 * Max vertical reach (in row heights) for the floor launch to the lowest text.
 * A bigger bottom gap is reelled onto with the grapple instead of a big jump.
 */
export const MAX_LAUNCH_GAP_FACTOR = 3;
export const GRAPPLE_DURATION = 0.55;
/** Max vertical gap (in row heights) a grapple will cross beyond climb reach. */
export const GRAPPLE_MAX_GAP_FACTOR = 12;
export const LANDING_RECOVERY = 0.35;
export const POINTER_BUMP_SPEED = 180;
export const BUMP_IMPULSE_FACTOR = 0.35;
export const MAX_BUMP_IMPULSE = 1600;
export const STATUS_GRACE_MS = 500;
export const TARGET_CONFIRM_SNAPSHOTS = 3;
export const ROUTE_RETRY_DURATION = 1.5;
export const SUMMIT_STABILITY_DURATION = 1.2;
export const EDGE_DROP_DURATION = 0.8;
export const SUMMIT_MANTLE_DURATION = 0.55;
export const FLAG_PLANT_DURATION = 0.8;
export const CAMP_PACK_DURATION = 0.45;

export const HAND_SPREAD = 9;
export const HAND_OFFSET_Y = 7;
export const HOLD_INSET = 3;
export const HAND_CENTER_OFFSET_X = SPRITE_WIDTH / 2;
export const MIN_HOLD_WIDTH = 2 * (HAND_SPREAD + HOLD_INSET);
export const MIN_HOLD_HEIGHT = 2 * HOLD_INSET;
export const HITBOX_PADDING = 10;
export const PACE_SPEED = 44;
export const MAX_FRAME_DELTA = 0.05;

export const EMPTY_HOLDS: readonly TerminalRow[] = Object.freeze([]);

export function createClimberMotionModel(
  displayWidth: number,
  displayHeight: number,
): ClimberMotionModel {
  return {
    state: 'grounded',
    resumeState: 'grounded',
    x: Math.max(0, (displayWidth - SPRITE_WIDTH) / 2),
    y: Math.max(0, displayHeight - SPRITE_HEIGHT),
    vx: 0,
    vy: 0,
    displayWidth,
    displayHeight,
    paceDirection: 1,
    attachedKey: null,
    leftHand: {
      key: null,
      x: displayWidth / 2 - HAND_SPREAD,
      y: displayHeight,
    },
    rightHand: {
      key: null,
      x: displayWidth / 2 + HAND_SPREAD,
      y: displayHeight,
    },
    slip: null,
    routePlanKeys: [],
    targetKey: null,
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
  };
}

export function resetClimberMotionModel(model: ClimberMotionModel): void {
  model.x = Math.max(
    0,
    Math.min(model.x, Math.max(0, model.displayWidth - SPRITE_WIDTH)),
  );
  model.y = Math.max(0, model.displayHeight - SPRITE_HEIGHT);
  model.vx = 0;
  model.vy = 0;
  model.leftHand = {
    key: null,
    x: model.x + HAND_CENTER_OFFSET_X - HAND_SPREAD,
    y: model.y + HAND_OFFSET_Y,
  };
  model.rightHand = {
    key: null,
    x: model.x + HAND_CENTER_OFFSET_X + HAND_SPREAD,
    y: model.y + HAND_OFFSET_Y,
  };
  model.slip = null;
  model.routePlanKeys.length = 0;
  model.attachedKey = null;
  model.targetKey = null;
  model.travel = null;
  model.holdFollow = null;
  model.grapple = null;
  model.phaseElapsed = 0;
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
  model.routeSearchAboveY = Number.POSITIVE_INFINITY;
  model.routeRetryElapsed = 0;
  model.summitStartY = 0;
  model.flagKey = null;
  model.flagAnchorRatio = 0.84;
  model.state = 'grounded';
  model.resumeState = 'grounded';
}
