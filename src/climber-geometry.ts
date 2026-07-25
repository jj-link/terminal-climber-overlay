import type { TerminalRow, TerminalSnapshot } from './row-tracker';
import type {
  ClimberMotionModel,
  HandAnchor,
  HandSide,
  ClimberState,
} from './climber-model';
import {
  HOLD_INSET,
  HAND_SPREAD,
  HAND_CENTER_OFFSET_X,
  HAND_OFFSET_Y,
  SPRITE_WIDTH,
  SPRITE_HEIGHT,
  MIN_HOLD_WIDTH,
  MIN_HOLD_HEIGHT,
} from './climber-model';

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function rowByKey(
  holds: readonly TerminalRow[],
  key: string | null,
): TerminalRow | undefined {
  return key ? holds.find((row) => row.key === key) : undefined;
}

function rowCenterY(row: TerminalRow): number {
  return row.rect.y + row.rect.height / 2;
}

export function isUsableHandHold(row: TerminalRow): boolean {
  return (
    row.attachable &&
    row.rect.width >= 2 * HOLD_INSET &&
    row.rect.height >= MIN_HOLD_HEIGHT
  );
}

export function isUsableClimberHold(row: TerminalRow): boolean {
  return (
    isUsableHandHold(row) &&
    row.rect.width >= MIN_HOLD_WIDTH
  );
}

export function remapHandAnchor(
  anchor: HandAnchor,
  previous: TerminalSnapshot,
  current: TerminalSnapshot,
  keyMappings: ReadonlyMap<string, string>,
): HandAnchor | null {
  if (!anchor.key) return { ...anchor };
  const mappedKey = keyMappings.get(anchor.key);
  if (!mappedKey) return null;
  const oldRow = previous.rows.find((row) => row.key === anchor.key);
  const newRow = current.rows.find((row) => row.key === mappedKey);
  if (!oldRow || !newRow) return null;
  const ratio =
    oldRow.rect.width > 0 && Number.isFinite(anchor.x)
      ? clamp((anchor.x - oldRow.rect.x) / oldRow.rect.width, 0, 1)
      : 0.5;
  return {
    key: mappedKey,
    x: clamp(
      newRow.rect.x + newRow.rect.width * ratio,
      minimumHandCenterX(newRow),
      maximumHandCenterX(newRow),
    ),
    y: attachmentHandY(newRow),
  };
}

export function minimumHandCenterX(row: TerminalRow): number {
  return row.rect.x + HOLD_INSET;
}

export function maximumHandCenterX(row: TerminalRow): number {
  return row.rect.x + row.rect.width - HOLD_INSET;
}

export function minimumTwoHandCenterX(row: TerminalRow): number {
  return row.rect.x + HOLD_INSET + HAND_SPREAD;
}

export function maximumTwoHandCenterX(row: TerminalRow): number {
  return row.rect.x + row.rect.width - HOLD_INSET - HAND_SPREAD;
}

export function attachmentHandY(row: TerminalRow): number {
  return clamp(
    rowCenterY(row),
    row.rect.y + HOLD_INSET,
    row.rect.y + row.rect.height - HOLD_INSET,
  );
}

export function handOffsetX(side: HandSide): number {
  return side === 'left' ? -HAND_SPREAD : HAND_SPREAD;
}

export function handAnchor(model: ClimberMotionModel, side: HandSide): HandAnchor {
  return side === 'left' ? model.leftHand : model.rightHand;
}

export function oppositeHand(side: HandSide): HandSide {
  return side === 'left' ? 'right' : 'left';
}

export function setHandAnchor(
  model: ClimberMotionModel,
  side: HandSide,
  key: string | null,
  x: number,
  y: number,
): void {
  const anchor = handAnchor(model, side);
  anchor.key = key;
  anchor.x = x;
  anchor.y = y;
}

export function clearRoutePlan(model: ClimberMotionModel): void {
  model.routePlanKeys.length = 0;
  model.targetKey = null;
  model.targetSnapshotCount = 0;
}

export function campBodyY(row: TerminalRow): number {
  return Math.max(0, row.rect.y - SPRITE_HEIGHT + HOLD_INSET);
}

export function flagAnchorRatio(row: TerminalRow, bodyCenterX: number): number {
  const rowCenterX = row.rect.x + row.rect.width / 2;
  const side = bodyCenterX <= rowCenterX ? 1 : -1;
  const anchorX = clamp(
    bodyCenterX + side * (SPRITE_WIDTH / 2 + 10),
    row.rect.x + HOLD_INSET,
    row.rect.x + row.rect.width - HOLD_INSET,
  );
  return (anchorX - row.rect.x) / row.rect.width;
}

export function isSummitState(state: ClimberState): boolean {
  return (
    state === 'summiting' ||
    state === 'planting' ||
    state === 'camped' ||
    state === 'packing'
  );
}

export function medianRowHeight(holds: readonly TerminalRow[]): number {
  if (holds.length === 0) return 16;
  const heights = holds.map((row) => row.rect.height).sort((a, b) => a - b);
  const middle = Math.floor(heights.length / 2);
  return heights.length % 2
    ? heights[middle]
    : (heights[middle - 1] + heights[middle]) / 2;
}
