import type { TerminalRow } from './row-tracker';
import type { ClimberMotionModel, HandSide } from './climber-model';
import {
  ROUTE_LOOKAHEAD_DEPTH,
  TARGET_CONFIRM_SNAPSHOTS,
  HAND_CENTER_OFFSET_X,
  GRAPPLE_MAX_GAP_FACTOR,
  MAX_CLIMB_GAP_FACTOR,
  MAX_CLIMB_REACH,
} from './climber-model';
import {
  isUsableHandHold,
  isUsableClimberHold,
  rowByKey,
  attachmentHandY,
  handAnchor,
  oppositeHand,
  handOffsetX,
  minimumHandCenterX,
  maximumHandCenterX,
  clamp,
} from './climber-geometry';

export function chooseLowestHold(
  holds: readonly TerminalRow[],
  handCenterX: number,
): TerminalRow | undefined {
  let best: TerminalRow | undefined;
  let bestBottom = Number.NEGATIVE_INFINITY;
  let bestHorizontal = Number.POSITIVE_INFINITY;
  for (const candidate of holds) {
    if (!isUsableHandHold(candidate)) continue;
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

interface ReachableStep {
  row: TerminalRow;
  verticalGap: number;
  horizontalMovement: number;
}

interface RouteResult {
  path: TerminalRow[];
  firstVerticalGap: number;
  totalVerticalGap: number;
  totalHorizontalMovement: number;
}

function reachableSteps(
  current: TerminalRow,
  holds: readonly TerminalRow[],
  handCenterX: number,
  rowHeight: number,
  searchAboveY: number,
  excludedKeys: ReadonlySet<string>,
): ReachableStep[] {
  const maximumReach = MAX_CLIMB_REACH;
  const currentY = attachmentHandY(current);
  const currentMinimumX = minimumHandCenterX(current);
  const currentMaximumX = maximumHandCenterX(current);
  const steps: ReachableStep[] = [];

  for (const candidate of holds) {
    if (
      candidate.key === current.key ||
      excludedKeys.has(candidate.key) ||
      !isUsableHandHold(candidate)
    ) {
      continue;
    }
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
      verticalGap > MAX_CLIMB_GAP_FACTOR * rowHeight ||
      reachGap > maximumReach
    ) {
      continue;
    }
    steps.push({ row: candidate, verticalGap, horizontalMovement });
  }
  steps.sort(
    (left, right) =>
      left.verticalGap - right.verticalGap ||
      left.horizontalMovement - right.horizontalMovement ||
      left.row.index - right.row.index ||
      left.row.segmentIndex - right.row.segmentIndex,
  );
  return steps;
}

function isBetterRoute(candidate: RouteResult, best: RouteResult): boolean {
  return (
    candidate.path.length > best.path.length ||
    (candidate.path.length === best.path.length &&
      (candidate.firstVerticalGap < best.firstVerticalGap ||
        (candidate.firstVerticalGap === best.firstVerticalGap &&
          (candidate.totalHorizontalMovement <
            best.totalHorizontalMovement ||
            (candidate.totalHorizontalMovement ===
              best.totalHorizontalMovement &&
              candidate.totalVerticalGap > best.totalVerticalGap)))))
  );
}

function chooseRoute(
  current: TerminalRow,
  holds: readonly TerminalRow[],
  handCenterX: number,
  rowHeight: number,
  searchAboveY = Number.POSITIVE_INFINITY,
): TerminalRow[] {
  let best: RouteResult = {
    path: [],
    firstVerticalGap: Number.POSITIVE_INFINITY,
    totalVerticalGap: 0,
    totalHorizontalMovement: Number.POSITIVE_INFINITY,
  };

  const search = (
    from: TerminalRow,
    fromHandX: number,
    path: TerminalRow[],
    firstVerticalGap: number,
    totalVerticalGap: number,
    totalHorizontalMovement: number,
  ): void => {
    if (path.length >= ROUTE_LOOKAHEAD_DEPTH) {
      const result = {
        path,
        firstVerticalGap,
        totalVerticalGap,
        totalHorizontalMovement,
      };
      if (isBetterRoute(result, best)) best = result;
      return;
    }

    const excludedKeys = new Set(path.map((row) => row.key));
    const steps = reachableSteps(
      from,
      holds,
      fromHandX,
      rowHeight,
      searchAboveY,
      excludedKeys,
    );
    if (steps.length === 0) {
      const result = {
        path,
        firstVerticalGap,
        totalVerticalGap,
        totalHorizontalMovement,
      };
      if (isBetterRoute(result, best)) best = result;
      return;
    }

    for (const step of steps) {
      const nextHandX = clamp(
        fromHandX,
        minimumHandCenterX(step.row),
        maximumHandCenterX(step.row),
      );
      search(
        step.row,
        nextHandX,
        [...path, step.row],
        path.length === 0 ? step.verticalGap : firstVerticalGap,
        totalVerticalGap + step.verticalGap,
        totalHorizontalMovement + step.horizontalMovement,
      );
    }
  };

  search(current, handCenterX, [], Number.POSITIVE_INFINITY, 0, 0);
  return best.path;
}

export function choosePlannedNextHold(
  model: ClimberMotionModel,
  current: TerminalRow,
  holds: readonly TerminalRow[],
  handCenterX: number,
  rowHeight: number,
  searchAboveY: number,
): TerminalRow | undefined {
  const planned = rowByKey(holds, model.routePlanKeys[0] ?? null);
  if (planned) {
    const reachable = reachableSteps(
      current,
      holds,
      handCenterX,
      rowHeight,
      searchAboveY,
      new Set<string>(),
    ).some((step) => step.row.key === planned.key);
    if (reachable) return planned;
  }
  model.routePlanKeys.length = 0;

  const route = chooseRoute(
    current,
    holds,
    handCenterX,
    rowHeight,
    searchAboveY,
  );
  model.routePlanKeys = route.map((row) => row.key);
  return route[0];
}

export function hasUsableHoldAbove(
  current: TerminalRow,
  holds: readonly TerminalRow[],
): boolean {
  const currentY = attachmentHandY(current);
  return holds.some(
    (candidate) =>
      candidate.key !== current.key &&
      isUsableHandHold(candidate) &&
      attachmentHandY(candidate) < currentY - 0.5,
  );
}

function climbMaximumReach(): number {
  return MAX_CLIMB_REACH;
}

function climbMaxGapForRowHeight(rowHeight: number): number {
  return MAX_CLIMB_GAP_FACTOR * rowHeight;
}

/**
 * True when a normal hand-to-hand climb step exists between any two usable
 * text holds anywhere on screen. The grapple is a last resort and must NOT
 * fire while such a path is available — the climber is expected to maneuver
 * over to it along the text instead of ignoring the layout.
 */
export function hasClimbingPathAnywhere(
  holds: readonly TerminalRow[],
  rowHeight: number,
): boolean {
  const maximumReach = climbMaximumReach();
  const climbGap = climbMaxGapForRowHeight(rowHeight);
  for (const current of holds) {
    if (!isUsableHandHold(current)) continue;
    const currentY = attachmentHandY(current);
    const currentMin = minimumHandCenterX(current);
    const currentMax = maximumHandCenterX(current);
    for (const candidate of holds) {
      if (candidate.key === current.key || !isUsableHandHold(candidate)) {
        continue;
      }
      const verticalGap = currentY - attachmentHandY(candidate);
      if (verticalGap <= 0 || verticalGap > climbGap) continue;
      const candidateMin = minimumHandCenterX(candidate);
      const candidateMax = maximumHandCenterX(candidate);
      const reachGap =
        candidateMin > currentMax
          ? candidateMin - currentMax
          : candidateMax < currentMin
            ? currentMin - candidateMax
            : 0;
      if (reachGap <= maximumReach) return true;
    }
  }
  return false;
}

/**
 * Returns the hand-center x along the current row the climber should shimmy to
 * in order to bring an upper text hold into hand-to-hand reach — i.e. pays out
 * a little lateral movement to reach a climbing path. Returns null when no such
 * step can be reached from anywhere on the current row (a true dead-end).
 */
export function findTraverseTarget(
  current: TerminalRow,
  holds: readonly TerminalRow[],
  handCenterX: number,
  rowHeight: number,
): number | null {
  const maximumReach = climbMaximumReach();
  const climbGap = climbMaxGapForRowHeight(rowHeight);
  const minX = minimumHandCenterX(current);
  const maxX = maximumHandCenterX(current);
  const currentY = attachmentHandY(current);
  let bestX: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const candidate of holds) {
    if (candidate.key === current.key || !isUsableHandHold(candidate)) {
      continue;
    }
    const verticalGap = currentY - attachmentHandY(candidate);
    if (verticalGap <= 0 || verticalGap > climbGap) continue;
    const candidateMin = minimumHandCenterX(candidate);
    const candidateMax = maximumHandCenterX(candidate);
    const lo = Math.max(minX, candidateMin - maximumReach);
    const hi = Math.min(maxX, candidateMax + maximumReach);
    if (lo > hi) continue;
    const targetX = clamp(handCenterX, lo, hi);
    const gap = Math.abs(targetX - handCenterX);
    if (gap < bestGap) {
      bestGap = gap;
      bestX = targetX;
    }
  }
  return bestX;
}

/**
 * Picks the hold a grapple reels the climber onto when the next usable text
 * hold sits beyond hand-to-hand reach (a vertical gap). The rope latches only
 * onto a climbable text hold; empty screen space is never grappled. Prefers the
 * candidate above with the least lateral drift, then the smallest gap.
 */
export function chooseGrappleTarget(
  current: TerminalRow,
  holds: readonly TerminalRow[],
  handCenterX: number,
  rowHeight: number,
): TerminalRow | undefined {
  const climbMaxGap = climbMaxGapForRowHeight(rowHeight);
  const grappleMaxGap = GRAPPLE_MAX_GAP_FACTOR * rowHeight;
  const currentY = attachmentHandY(current);
  let best: TerminalRow | undefined;
  let bestWeight = Number.POSITIVE_INFINITY;

  for (const candidate of holds) {
    if (candidate.key === current.key || !isUsableClimberHold(candidate)) {
      continue;
    }
    const candidateY = attachmentHandY(candidate);
    const verticalGap = currentY - candidateY;
    // Only cross a gap the hands cannot already reach.
    if (verticalGap <= climbMaxGap || verticalGap > grappleMaxGap) {
      continue;
    }
    const targetHandX = clamp(
      handCenterX,
      minimumHandCenterX(candidate),
      maximumHandCenterX(candidate),
    );
    const horizontal = Math.abs(targetHandX - handCenterX);
    const weight = horizontal * 1000 + verticalGap;
    if (weight < bestWeight) {
      best = candidate;
      bestWeight = weight;
    }
  }
  return best;
}

export function hasConfirmedNextHold(
  model: ClimberMotionModel,
  next: TerminalRow | undefined,
): next is TerminalRow {
  if (!next) {
    model.targetKey = null;
    model.targetSnapshotCount = 0;
    model.routePlanKeys.length = 0;
    return false;
  }
  if (model.targetKey !== next.key) {
    model.targetKey = next.key;
    model.targetSnapshotCount = 1;
    return false;
  }
  return model.targetSnapshotCount >= TARGET_CONFIRM_SNAPSHOTS;
}
