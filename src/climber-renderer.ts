import type { TerminalBackendStatus } from './contracts';
import type { TerminalRow } from './row-tracker';
import type {
  ClimberMotionModel,
  ClimberState,
  HandSide,
} from './climber-model';
import {
  SPRITE_WIDTH,
  SPRITE_HEIGHT,
  HAND_CENTER_OFFSET_X,
  HAND_OFFSET_Y,
  HOLD_INSET,
  SUMMIT_MANTLE_DURATION,
  FLAG_PLANT_DURATION,
  CAMP_PACK_DURATION,
} from './climber-model';
import {
  clamp,
  rowByKey,
  flagAnchorRatio,
  isSummitState,
} from './climber-geometry';

export interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

export interface ClimberRendererOptions {
  canvas: HTMLCanvasElement;
  spriteUrl?: string;
  spriteImage?: CanvasImageSource;
  createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserverLike;
  reducedMotion?: boolean;
}

export interface ClimberRenderFrame {
  motion: Readonly<ClimberMotionModel>;
  holds: readonly TerminalRow[];
  backendStatus: TerminalBackendStatus;
  timestamp: number;
  bumped: boolean;
}

export function selectClimberSpriteCell(
  state: ClimberState,
  timestamp: number,
  bumped: boolean,
  reducedMotion: boolean,
  phaseElapsed = 0,
  slippingHand?: HandSide | null,
): number {
  if (bumped) return 23;
  const frame = reducedMotion ? 0 : Math.floor(timestamp / 140);

  if (state === 'slipping' && slippingHand) {
    if (reducedMotion) return slippingHand === 'left' ? 4 : 6;
    const pairFrame = frame % 2;
    return slippingHand === 'left' ? 4 + pairFrame : 6 + pairFrame;
  }

  switch (state) {
    case 'hanging':
    case 'shimmying':
      return frame % 8;
    case 'climbing': {
      if (reducedMotion) return 8;
      // 4-beat climb driven by travel progress (0..1): search, pull, drive,
      // place. Synced to the body reach so limbs never swim out of phase.
      const p = clamp(phaseElapsed, 0, 1);
      if (p < 0.25) return 8;
      if (p < 0.5) return 9;
      if (p < 0.75) return 10;
      return 11;
    }
    case 'launching':
      if (reducedMotion) return 12;
      return phaseElapsed < 0.5 ? 12 : 13;
    case 'grappling':
      // Throw then pull overhead. The rendered rope line carries the rest.
      if (reducedMotion) return 24;
      return phaseElapsed < 0.3 ? 4 : 24;
    case 'summiting':
      if (reducedMotion) return 24;
      return phaseElapsed < SUMMIT_MANTLE_DURATION * 0.58 ? 24 : 25;
    case 'planting':
      if (reducedMotion) return 26;
      return phaseElapsed < FLAG_PLANT_DURATION * 0.5 ? 26 : 27;
    case 'camped': {
      if (reducedMotion) return 28;
      const campCycle = phaseElapsed % 12;
      if (campCycle >= 5 && campCycle < 6) return 29;
      return campCycle >= 8 ? 30 : 28;
    }
    case 'packing':
      return 31;
    case 'falling':
      return reducedMotion
        ? 14
        : frame % 4 < 2
          ? 14 + (frame % 2)
          : 16 + (frame % 2);
    case 'slipping':
      // No slippingHand provided — fall back to a neutral cell.
      return 0;
    case 'landing':
      return 18 + (frame % 3);
    case 'paused':
    case 'grounded':
      return 21 + (frame % 2);
  }
}

export class ClimberRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D | null;
  readonly #resizeObserver: ResizeObserverLike | null;
  readonly #sprite: CanvasImageSource | null;
  #spriteLoaded = false;
  #devicePixelRatio = 1;
  #reducedMotion: boolean;
  #motionPreference: MediaQueryList | null = null;
  readonly #handleMotionPreference = (event: MediaQueryListEvent): void => {
    this.#reducedMotion = event.matches;
  };

  constructor(options: ClimberRendererOptions) {
    this.#canvas = options.canvas;
    this.#context = options.canvas.getContext('2d') ?? null;

    if (options.reducedMotion !== undefined) {
      this.#reducedMotion = options.reducedMotion;
    } else if (typeof matchMedia !== 'undefined') {
      this.#motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
      this.#reducedMotion = this.#motionPreference.matches;
      this.#motionPreference.addEventListener(
        'change',
        this.#handleMotionPreference,
      );
    } else {
      this.#reducedMotion = false;
    }

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
    } else {
      this.#sprite = null;
    }

    const createObserver =
      options.createResizeObserver ??
      (typeof ResizeObserver !== 'undefined'
        ? (callback: ResizeObserverCallback) => new ResizeObserver(callback)
        : undefined);
    this.#resizeObserver = createObserver
      ? createObserver(() => this.#resizeCanvas())
      : null;
    this.#resizeObserver?.observe(this.#canvas);
    this.#resizeCanvas();
  }

  render(frame: ClimberRenderFrame): void {
    if (!this.#context) return;
    const context = this.#context;
    const ratio = this.#devicePixelRatio;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = false;

    const motion = frame.motion;
    const pausedAtSummit =
      motion.state === 'paused' && isSummitState(motion.resumeState);
    const visualState: ClimberState =
      pausedAtSummit ? motion.resumeState : motion.state;

    this.#renderCampsite(context, frame, visualState);
    this.#renderGrapple(context, motion, visualState);

    const cell = selectClimberSpriteCell(
      visualState,
      frame.timestamp,
      frame.bumped,
      this.#reducedMotion,
      motion.phaseElapsed,
      motion.slip?.side ?? null,
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
        Math.round(motion.x),
        Math.round(motion.y),
        SPRITE_WIDTH,
        SPRITE_HEIGHT,
      );
      return;
    }

    // A quiet fallback while the atlas decodes; it is replaced, not animated.
    context.fillStyle = '#e85a2c';
    context.fillRect(
      Math.round(motion.x + 9),
      Math.round(motion.y + 13),
      22,
      25,
    );
    context.fillStyle = '#f6ead2';
    context.fillRect(
      Math.round(motion.x + 11),
      Math.round(motion.y + 2),
      18,
      13,
    );
    context.fillStyle = '#0f6b63';
    context.fillRect(
      Math.round(motion.x + 10),
      Math.round(motion.y + 38),
      8,
      14,
    );
    context.fillRect(
      Math.round(motion.x + 22),
      Math.round(motion.y + 38),
      8,
      14,
    );
  }

  destroy(): void {
    this.#resizeObserver?.disconnect();
    this.#motionPreference?.removeEventListener(
      'change',
      this.#handleMotionPreference,
    );
  }

  #resizeCanvas(): void {
    if (!this.#context) return;
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

  #renderGrapple(
    context: CanvasRenderingContext2D,
    motion: Readonly<ClimberMotionModel>,
    visualState: ClimberState,
  ): void {
    if (visualState !== 'grappling' || !motion.grapple) return;
    const grapple = motion.grapple;
    const lead =
      grapple.leadHand === 'left' ? motion.leftHand : motion.rightHand;
    const ropeStartX = Math.round(lead.x);
    const ropeStartY = Math.round(lead.y + 4);
    const ropeEndX = Math.round(grapple.anchorX);
    const ropeEndY = Math.round(grapple.anchorY);
    context.strokeStyle = '#101719';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(ropeStartX, ropeStartY);
    context.lineTo(ropeEndX, ropeEndY);
    context.stroke();
    // Grapple hook at the latch point on the text row.
    context.fillStyle = '#f0e6cb';
    context.fillRect(ropeEndX - 2, ropeEndY - 2, 4, 4);
  }

  #renderCampsite(
    context: CanvasRenderingContext2D,
    frame: ClimberRenderFrame,
    visualState: ClimberState,
  ): void {
    if (
      frame.backendStatus !== 'tracking' &&
      frame.backendStatus !== 'paused'
    ) {
      return;
    }
    const motion = frame.motion;
    const plantedRow = rowByKey(frame.holds, motion.flagKey);
    const plantingRow =
      visualState === 'planting'
        ? rowByKey(frame.holds, motion.attachedKey)
        : undefined;
    const flagRow = plantedRow ?? plantingRow;
    if (flagRow) {
      let deployment = 1;
      if (visualState === 'planting' && !plantedRow) {
        deployment = clamp(
          motion.phaseElapsed / FLAG_PLANT_DURATION,
          0,
          1,
        );
      } else if (
        visualState === 'packing' &&
        plantedRow?.key === motion.attachedKey
      ) {
        deployment =
          1 -
          clamp(motion.phaseElapsed / CAMP_PACK_DURATION, 0, 1);
      }
      if (deployment > 0) {
        const anchorRatio = plantedRow
          ? motion.flagAnchorRatio
          : flagAnchorRatio(
              flagRow,
              motion.x + HAND_CENTER_OFFSET_X,
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
              : Math.floor(frame.timestamp / 180) % 2;
          const flagWidth = Math.round(17 * unfurl);
          context.beginPath();
          context.moveTo(anchorX + 1, poleTopY + 2);
          context.lineTo(anchorX + 1 + flagWidth, poleTopY + 6 + flutter);
          context.lineTo(anchorX + 1, poleTopY + 12);
          context.closePath();
          context.fillStyle = '#e85a2c';
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
      motion.attachedKey
    ) {
      const row = rowByKey(frame.holds, motion.attachedKey);
      if (row) {
        const bodyCenterX = motion.x + HAND_CENTER_OFFSET_X;
        const campsiteAnchorRatio =
          motion.flagKey === row.key
            ? motion.flagAnchorRatio
            : flagAnchorRatio(row, bodyCenterX);
        const flagIsRightOfClimber =
          row.rect.x + row.rect.width * campsiteAnchorRatio >= bodyCenterX;
        const gearX = Math.round(
          clamp(
            motion.x +
              (flagIsRightOfClimber ? -5 : SPRITE_WIDTH - 7),
            row.rect.x,
            row.rect.x + row.rect.width - 12,
          ),
        );
        const gearY = Math.round(row.rect.y - 7);
        context.fillStyle = '#101719';
        context.fillRect(gearX - 1, gearY - 1, 14, 7);
        context.fillStyle = '#0f6b63';
        context.fillRect(gearX, gearY, 12, 5);
        context.fillStyle = '#f6ead2';
        context.fillRect(gearX + 5, gearY, 2, 5);
      }
    }
  }
}
