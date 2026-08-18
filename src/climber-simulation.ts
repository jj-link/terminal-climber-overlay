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
import type { ClimberState, HandSide, Point } from './climber-model';
import {
  createClimberMotionModel,
  resetClimberMotionModel,
  type ClimberMotionModel,
  type ClimberMotionEnvironment,
  SPRITE_WIDTH,
  SPRITE_HEIGHT,
  HAND_CENTER_OFFSET_X,
  HAND_OFFSET_Y,
  HAND_SPREAD,
  HOLD_INSET,
  HITBOX_PADDING,
  POINTER_BUMP_SPEED,
  BUMP_IMPULSE_FACTOR,
  MAX_BUMP_IMPULSE,
  STATUS_GRACE_MS,
  EMPTY_HOLDS,
} from './climber-model';
import {
  clamp,
  rowByKey,
  handAnchor,
  oppositeHand,
  handOffsetX,
  remapHandAnchor,
  setHandAnchor,
  attachmentHandY,
  minimumHandCenterX,
  maximumHandCenterX,
  isSummitState,
  isUsableHandHold,
  campBodyY,
  medianRowHeight,
} from './climber-geometry';
import {
  beginFall,
  beginOneHandSlip,
  setMotionState,
  isAttachedState,
  reduceClimberMotion,
} from './climber-motion';
import {
  ClimberRenderer,
  type ResizeObserverLike,
} from './climber-renderer';

export interface ClimberObservableState {
  state: ClimberState;
  holdCount: number;
  position: Readonly<Point>;
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

function chooseSlipSide(model: ClimberMotionModel, point: Point): HandSide {
  const leftDistance = Math.hypot(
    point.x - model.leftHand.x,
    point.y - model.leftHand.y,
  );
  const rightDistance = Math.hypot(
    point.x - model.rightHand.x,
    point.y - model.rightHand.y,
  );
  return leftDistance <= rightDistance ? 'left' : 'right';
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

export class ClimberSimulation {
  readonly #clock: () => number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #onStateChange?: (state: ClimberObservableState) => void;
  readonly #renderer: ClimberRenderer | null;
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
  #frameHandle: number | null = null;
  #lastFrameTimestamp: number | null = null;
  #destroyed = false;
  #bumpUntil = 0;
  #lastObservedState: ClimberState;
  #lastObservedHoldCount = -1;
  readonly #onAnimationFrame = (timestamp: number): void => {
    this.#frameHandle = null;
    this.#frame(timestamp);
    this.#scheduleFrame();
  };

  constructor(options: ClimberSimulationOptions) {
    this.#clock = options.clock ?? (() => performance.now());
    this.#onStateChange = options.onStateChange;

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
    this.#motion = createClimberMotionModel(initialWidth, initialHeight);
    this.#lastObservedState = this.#motion.state;

    if (options.canvas) {
      this.#renderer = new ClimberRenderer({
        canvas: options.canvas,
        spriteUrl: options.spriteUrl,
        spriteImage: options.spriteImage,
        createResizeObserver: options.createResizeObserver,
        reducedMotion: options.reducedMotion,
      });
    } else {
      this.#renderer = null;
    }

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

  get velocity(): Readonly<Point> {
    return { x: this.#motion.vx, y: this.#motion.vy };
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
    const usableHolds = getAttachableRows(next).filter(isUsableHandHold);
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
      if (previous) {
        for (const side of ['left', 'right'] as const) {
          const anchor = handAnchor(this.#motion, side);
          const mappedAnchor = remapHandAnchor(
            anchor,
            previous,
            next,
            reconciliation.keyMappings,
          );
          if (mappedAnchor) {
            anchor.key = mappedAnchor.key;
            anchor.x = mappedAnchor.x;
            anchor.y = mappedAnchor.y;
          }
        }
      }
      const canBrace =
        isAttachedState(this.#motion.state) &&
        this.#motion.leftHand.key !== null &&
        this.#motion.rightHand.key !== null &&
        this.#motion.leftHand.key === this.#motion.rightHand.key;
      if (canBrace) {
        const slipSide =
          this.#motion.travel?.leadHand ??
          (this.#motion.paceDirection === 1 ? 'right' : 'left');
        if (beginOneHandSlip(this.#motion, slipSide)) {
          this.#notify(true);
          return;
        }
      }
      beginFall(this.#motion);
      this.#notify(true);
      return;
    }

    if (!previous) {
      this.#notify(true);
      return;
    }

    const followHandStart = {
      left: { x: this.#motion.leftHand.x, y: this.#motion.leftHand.y },
      right: { x: this.#motion.rightHand.x, y: this.#motion.rightHand.y },
    };
    const remapAnchor = (side: HandSide): void => {
      const anchor = handAnchor(this.#motion, side);
      const mappedAnchor = remapHandAnchor(
        anchor,
        previous,
        next,
        reconciliation.keyMappings,
      );
      if (mappedAnchor) {
        anchor.key = mappedAnchor.key;
        anchor.x = mappedAnchor.x;
        anchor.y = mappedAnchor.y;
      } else {
        anchor.key = null;
        anchor.x =
          this.#motion.x +
          HAND_CENTER_OFFSET_X +
          handOffsetX(side);
        anchor.y = this.#motion.y + HAND_OFFSET_Y;
      }
    };
    remapAnchor('left');
    remapAnchor('right');
    this.#motion.routePlanKeys = this.#motion.routePlanKeys
      .map((key) => reconciliation.keyMappings.get(key) ?? null)
      .filter((key): key is string => key !== null);

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
              handStart: followHandStart,
              handTarget: {
                left: { x: this.#motion.leftHand.x, y: this.#motion.leftHand.y },
                right: { x: this.#motion.rightHand.x, y: this.#motion.rightHand.y },
              },
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
              handStart: followHandStart,
              handTarget: {
                left: { x: this.#motion.leftHand.x, y: this.#motion.leftHand.y },
                right: { x: this.#motion.rightHand.x, y: this.#motion.rightHand.y },
              },
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
        if (this.#motion.grapple) {
          this.#motion.grapple.targetKey = mappedTarget;
        }
        if (this.#motion.travel && previousTarget) {
          const travelTarget = rowByKey(
            this.#motionEnvironment.holds,
            mappedTarget,
          );
          if (travelTarget) {
            const ratio =
              previousTarget.rect.width > 0
                ? clamp(
                    (this.#motion.travel.targetHandX - previousTarget.rect.x) /
                      previousTarget.rect.width,
                    0,
                    1,
                  )
                : 0.5;
            this.#motion.travel.targetHandX = clamp(
              travelTarget.rect.x + travelTarget.rect.width * ratio,
              minimumHandCenterX(travelTarget),
              maximumHandCenterX(travelTarget),
            );
            this.#motion.travel.targetHandY = attachmentHandY(travelTarget);
            this.#motion.travel.targetBodyX =
              this.#motion.travel.targetHandX -
              HAND_CENTER_OFFSET_X -
              handOffsetX(this.#motion.travel.leadHand);
          }
          if (this.#motion.travel.trailingKey) {
            this.#motion.travel.trailingKey =
              reconciliation.keyMappings.get(
                this.#motion.travel.trailingKey,
              ) ?? null;
          }
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
      const cursorVy = dy / elapsedSeconds;
      const canSlip =
        this.#motion.leftHand.key !== null &&
        this.#motion.rightHand.key !== null &&
        this.#motion.leftHand.key === this.#motion.rightHand.key;
      if (canSlip && this.#motion.state !== 'launching') {
        const side = chooseSlipSide(this.#motion, {
          x: (previous.point.x + point.x) / 2,
          y: (previous.point.y + point.y) / 2,
        });
        if (beginOneHandSlip(this.#motion, side, cursorVx * BUMP_IMPULSE_FACTOR)) {
          this.#notify(true);
          return;
        }
      }
      beginFall(
        this.#motion,
        clamp(cursorVx * BUMP_IMPULSE_FACTOR, -MAX_BUMP_IMPULSE, MAX_BUMP_IMPULSE),
        clamp(cursorVy * BUMP_IMPULSE_FACTOR, -MAX_BUMP_IMPULSE, MAX_BUMP_IMPULSE),
      );
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
    const wasPaused = this.#motion.state === 'paused';
    resetClimberMotionModel(this.#motion);
    if (wasPaused) {
      this.#motion.state = 'paused';
    }
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
    this.#renderer?.destroy();
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
    this.#renderer?.render({
      motion: this.#motion,
      holds: this.#motionEnvironment.holds,
      backendStatus: this.#backendStatus,
      timestamp,
      bumped: this.#bumpUntil > this.#clock(),
    });
    this.#notify(false);
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
