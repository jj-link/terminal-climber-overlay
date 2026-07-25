import type { TerminalRow } from './row-tracker';
import type { ClimberMotionModel, HandSide } from './climber-model';
import {
  ROUTE_LOOKAHEAD_DEPTH,
  TARGET_CONFIRM_SNAPSHOTS,
  HAND_CENTER_OFFSET_X,
} from './climber-model';
import {
  isUsableHandHold,
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
  const maximumReach = Math.max(96, 6 * rowHeight);
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
      verticalGap > 4 * rowHeight ||
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
