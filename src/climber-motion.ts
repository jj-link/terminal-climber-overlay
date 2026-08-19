import type { TerminalRow } from './row-tracker';
import type {
  ClimberMotionModel,
  ClimberMotionEnvironment,
  ClimberState,
  HandSide,
  HandAnchor,
  Travel,
  Grapple,
} from './climber-model';
import {
  HAND_CENTER_OFFSET_X,
  HAND_OFFSET_Y,
  HAND_SPREAD,
  SPRITE_WIDTH,
  SPRITE_HEIGHT,
  GRAVITY,
  MAX_FALL_SPEED,
  SHIMMY_SPEED,
  SLIP_DURATION,
  MIN_HOLD_WIDTH,
  CLIMB_DURATION,
  LAUNCH_DURATION,
  LANDING_RECOVERY,
  SUMMIT_MANTLE_DURATION,
  FLAG_PLANT_DURATION,
  CAMP_PACK_DURATION,
  SUMMIT_STABILITY_DURATION,
  ROUTE_RETRY_DURATION,
  GRAPPLE_DURATION,
  MAX_LAUNCH_GAP_FACTOR,
  MAX_FRAME_DELTA,
  PACE_SPEED,
} from './climber-model';
import {
  clamp,
  rowByKey,
  attachmentHandY,
  handAnchor,
  oppositeHand,
  handOffsetX,
  setHandAnchor,
  clearRoutePlan,
  minimumHandCenterX,
  maximumHandCenterX,
  minimumTwoHandCenterX,
  maximumTwoHandCenterX,
  isSummitState,
  campBodyY,
  flagAnchorRatio,
  medianRowHeight,
} from './climber-geometry';
import {
  chooseLowestHold,
  choosePlannedNextHold,
  chooseGrappleTarget,
  hasConfirmedNextHold,
  hasUsableHoldAbove,
  hasClimbingPathAnywhere,
  findTraverseTarget,
} from './climber-routing';

function moveToward(value: number, target: number, distance: number): number {
  if (Math.abs(target - value) <= distance) return target;
  return value + Math.sign(target - value) * distance;
}

function smoothstep(progress: number): number {
  const t = clamp(progress, 0, 1);
  return t * t * (3 - 2 * t);
}

export function setMotionState(model: ClimberMotionModel, state: ClimberState): void {
  model.state = state;
  model.phaseElapsed = 0;
  if (state !== 'paused') model.resumeState = state;
}

function followsAttachedRow(state: ClimberState): boolean {
  return (
    state === 'hanging' ||
    state === 'shimmying' ||
    state === 'slipping' ||
    isSummitState(state)
  );
}

export function beginFall(
  model: ClimberMotionModel,
  vx = model.vx,
  vy?: number,
): void {
  model.attachedKey = null;
  model.targetKey = null;
  model.leftHand.key = null;
  model.rightHand.key = null;
  model.slip = null;
  model.routePlanKeys.length = 0;
  model.travel = null;
  model.holdFollow = null;
  model.grapple = null;
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
  model.routeSearchAboveY = Number.POSITIVE_INFINITY;
  model.routeRetryElapsed = 0;
  model.vx = vx;
  model.vy = vy ?? Math.max(model.vy, 0);
  setMotionState(model, 'falling');
}

export function beginOneHandSlip(
  model: ClimberMotionModel,
  side: HandSide,
  vx = 0,
): boolean {
  const slippingAnchor = handAnchor(model, side);
  const supportingAnchor = handAnchor(model, oppositeHand(side));
  if (!supportingAnchor.key) {
    beginFall(model, vx);
    return false;
  }

  model.slip = {
    side,
    x: slippingAnchor.x,
    y: slippingAnchor.y,
    elapsed: 0,
    duration: SLIP_DURATION,
    vx: clamp(vx, -160, 160),
    vy: 70,
  };
  slippingAnchor.key = null;
  model.attachedKey = supportingAnchor.key;
  model.travel = null;
  model.holdFollow = null;
  model.grapple = null;
  clearRoutePlan(model);
  model.summitStableElapsed = 0;
  model.routeSearchAboveY = Number.POSITIVE_INFINITY;
  model.routeRetryElapsed = 0;
  setMotionState(model, 'slipping');
  return true;
}

function attachToRow(
  model: ClimberMotionModel,
  row: TerminalRow,
  leadHand: HandSide = model.travel?.leadHand ?? 'right',
): void {
  const handY = attachmentHandY(row);
  const sourceCenterX = model.x + HAND_CENTER_OFFSET_X;
  if (row.rect.width >= MIN_HOLD_WIDTH) {
    const handCenterX = clamp(
      sourceCenterX,
      minimumTwoHandCenterX(row),
      maximumTwoHandCenterX(row),
    );
    model.x = handCenterX - HAND_CENTER_OFFSET_X;
    setHandAnchor(
      model,
      'left',
      row.key,
      handCenterX - HAND_SPREAD,
      handY,
    );
    setHandAnchor(
      model,
      'right',
      row.key,
      handCenterX + HAND_SPREAD,
      handY,
    );
  } else {
    const leadAnchor = handAnchor(model, leadHand);
    const leadX = clamp(
      leadAnchor.key && Number.isFinite(leadAnchor.x)
        ? leadAnchor.x
        : sourceCenterX,
      minimumHandCenterX(row),
      maximumHandCenterX(row),
    );
    const trailingHand = oppositeHand(leadHand);
    model.x = leadX - HAND_CENTER_OFFSET_X - handOffsetX(leadHand);
    setHandAnchor(model, leadHand, row.key, leadX, handY);
    setHandAnchor(
      model,
      trailingHand,
      null,
      model.x + HAND_CENTER_OFFSET_X + handOffsetX(trailingHand),
      handY,
    );
  }
  model.y = handY - HAND_OFFSET_Y;
  model.vx = 0;
  model.vy = 0;
  model.attachedKey = row.key;
  model.slip = null;
  model.travel = null;
  model.grapple = null;
  clearRoutePlan(model);
  model.summitStableElapsed = 0;
  model.routeSearchAboveY = Number.POSITIVE_INFINITY;
  model.routeRetryElapsed = 0;
  setMotionState(model, 'hanging');
}

function alignBodyToAttachedHands(
  model: ClimberMotionModel,
  current: TerminalRow,
): number {
  const handY = attachmentHandY(current);
  const leftOnCurrent = model.leftHand.key === current.key;
  const rightOnCurrent = model.rightHand.key === current.key;
  if (
    !leftOnCurrent &&
    !rightOnCurrent &&
    model.attachedKey === current.key
  ) {
    const handCenterX = clamp(
      model.x + HAND_CENTER_OFFSET_X,
      minimumHandCenterX(current),
      maximumHandCenterX(current),
    );
    if (current.rect.width >= MIN_HOLD_WIDTH) {
      setHandAnchor(model, 'left', current.key, handCenterX - HAND_SPREAD, handY);
      setHandAnchor(model, 'right', current.key, handCenterX + HAND_SPREAD, handY);
    } else {
      setHandAnchor(model, 'right', current.key, handCenterX, handY);
    }
    model.x = handCenterX - HAND_CENTER_OFFSET_X;
    model.y = handY - HAND_OFFSET_Y;
    return handCenterX;
  }
  if (leftOnCurrent && rightOnCurrent && current.rect.width < MIN_HOLD_WIDTH) {
    setHandAnchor(
      model,
      'right',
      null,
      model.x + HAND_CENTER_OFFSET_X + HAND_SPREAD,
      handY,
    );
  }
  if (leftOnCurrent && rightOnCurrent && current.rect.width >= MIN_HOLD_WIDTH) {
    const handCenterX = clamp(
      model.x + HAND_CENTER_OFFSET_X,
      minimumTwoHandCenterX(current),
      maximumTwoHandCenterX(current),
    );
    model.x = handCenterX - HAND_CENTER_OFFSET_X;
    model.y = handY - HAND_OFFSET_Y;
    setHandAnchor(model, 'left', current.key, handCenterX - HAND_SPREAD, handY);
    setHandAnchor(model, 'right', current.key, handCenterX + HAND_SPREAD, handY);
    return handCenterX;
  }

  const supportingSide = leftOnCurrent ? 'left' : 'right';
  const supportingAnchor = handAnchor(model, supportingSide);
  if (!supportingAnchor.key) {
    attachToRow(model, current, supportingSide);
    return model.x + HAND_CENTER_OFFSET_X;
  }
  supportingAnchor.x = clamp(
    supportingAnchor.x,
    minimumHandCenterX(current),
    maximumHandCenterX(current),
  );
  supportingAnchor.y = handY;
  model.x =
    supportingAnchor.x -
    HAND_CENTER_OFFSET_X -
    handOffsetX(supportingSide);
  model.y = handY - HAND_OFFSET_Y;
  return supportingAnchor.x;
}

function chooseLeadHand(model: ClimberMotionModel, target: TerminalRow): HandSide {
  if (!model.leftHand.key) return 'left';
  if (!model.rightHand.key) return 'right';
  const targetCenterX = target.rect.x + target.rect.width / 2;
  const bodyCenterX = model.x + HAND_CENTER_OFFSET_X;
  if (targetCenterX < bodyCenterX - 2) return 'left';
  if (targetCenterX > bodyCenterX + 2) return 'right';
  return model.paceDirection === 1 ? 'right' : 'left';
}

function startTravel(
  model: ClimberMotionModel,
  kind: Travel['kind'],
  target: TerminalRow,
  duration: number,
): void {
  const leadHand = chooseLeadHand(model, target);
  const leadAnchor = handAnchor(model, leadHand);
  const trailingKey = model.attachedKey;
  const startLeadX =
    leadAnchor.key && Number.isFinite(leadAnchor.x)
      ? leadAnchor.x
      : model.x + HAND_CENTER_OFFSET_X + handOffsetX(leadHand);
  const startLeadY = Number.isFinite(leadAnchor.y)
    ? leadAnchor.y
    : model.y + HAND_OFFSET_Y;
  const targetHandX = clamp(
    startLeadX,
    minimumHandCenterX(target),
    maximumHandCenterX(target),
  );
  const targetBodyX =
    targetHandX - HAND_CENTER_OFFSET_X - handOffsetX(leadHand);
  model.targetKey = target.key;
  if (model.routePlanKeys[0] === target.key) model.routePlanKeys.shift();
  model.travel = {
    kind,
    targetKey: target.key,
    leadHand,
    trailingKey,
    startX: model.x,
    startY: model.y,
    startLeadX,
    startLeadY,
    targetBodyX,
    targetHandX,
    targetHandY: attachmentHandY(target),
    elapsed: 0,
    duration,
  };
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
  setMotionState(model, kind === 'launch' ? 'launching' : 'climbing');
}

function startGrapple(
  model: ClimberMotionModel,
  target: TerminalRow,
): void {
  const leadHand = chooseLeadHand(model, target);
  const lead = handAnchor(model, leadHand);
  const startLeadX = Number.isFinite(lead.x) ? lead.x : model.x + HAND_CENTER_OFFSET_X + handOffsetX(leadHand);
  const startLeadY = Number.isFinite(lead.y) ? lead.y : model.y + HAND_OFFSET_Y;
  const anchorX = clamp(
    startLeadX,
    minimumHandCenterX(target),
    maximumHandCenterX(target),
  );
  const anchorY = attachmentHandY(target);
  const endX = anchorX - HAND_CENTER_OFFSET_X - handOffsetX(leadHand);
  const endY = anchorY - HAND_OFFSET_Y;
  model.grapple = {
    targetKey: target.key,
    leadHand,
    startX: model.x,
    startY: model.y,
    endX,
    endY,
    handStart: { x: startLeadX, y: startLeadY },
    handEnd: { x: anchorX, y: anchorY },
    anchorX,
    anchorY,
    elapsed: 0,
    duration: GRAPPLE_DURATION,
  };
  model.attachedKey = target.key;
  model.travel = null;
  model.holdFollow = null;
  model.slip = null;
  clearRoutePlan(model);
  model.targetKey = target.key;
  model.summitStableElapsed = 0;
  model.targetSnapshotCount = 0;
  setMotionState(model, 'grappling');
}

export function isAttachedState(state: ClimberState): boolean {
  return (
    state === 'launching' ||
    state === 'hanging' ||
    state === 'shimmying' ||
    state === 'climbing' ||
    state === 'slipping' ||
    state === 'grappling' ||
    isSummitState(state)
  );
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
    for (const side of ['left', 'right'] as const) {
      const start = follow.handStart[side];
      const target = follow.handTarget[side];
      const anchor = handAnchor(model, side);
      anchor.x = start.x + (target.x - start.x) * progress;
      anchor.y = start.y + (target.y - start.y) * progress;
    }
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
      // Shimmy along the floor to be directly under the lowest text first.
      model.x = moveToward(model.x, launchX, SHIMMY_SPEED * dt);
      if (model.x === launchX) {
        // Only a modest bottom gap is a launch; a large one is reelled with the
        // rope so the climber never leaps from the floor up over empty space.
        const reach =
          model.y + HAND_OFFSET_Y - attachmentHandY(lowest);
        if (
          reach <=
          MAX_LAUNCH_GAP_FACTOR * cachedMedianRowHeight
        ) {
          startTravel(model, 'launch', lowest, LAUNCH_DURATION);
        } else {
          startGrapple(model, lowest);
        }
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
      travel.targetBodyX =
        travel.targetHandX -
        HAND_CENTER_OFFSET_X -
        handOffsetX(travel.leadHand);
      const progress = smoothstep(travel.elapsed / travel.duration);
      // Keep the sprite phase in lockstep with the body translation so the
      // limb cycle never swims independently of the actual reach-and-pull.
      model.phaseElapsed = progress;
      model.x =
        travel.startX + (travel.targetBodyX - travel.startX) * progress;
      model.y =
        travel.startY +
        (travel.targetHandY - HAND_OFFSET_Y - travel.startY) * progress;

      const lead = handAnchor(model, travel.leadHand);
      lead.x =
        travel.startLeadX +
        (travel.targetHandX - travel.startLeadX) * progress;
      lead.y =
        travel.startLeadY +
        (travel.targetHandY - travel.startLeadY) * progress;
      const trailing = handAnchor(model, oppositeHand(travel.leadHand));
      if (travel.trailingKey && trailing.key === travel.trailingKey) {
        const trailingRow = rowByKey(holds, travel.trailingKey);
        if (trailingRow) trailing.y = attachmentHandY(trailingRow);
      } else {
        trailing.x =
          model.x +
          HAND_CENTER_OFFSET_X +
          handOffsetX(oppositeHand(travel.leadHand));
        trailing.y = model.y + HAND_OFFSET_Y;
      }
      if (travel.elapsed >= travel.duration) {
        attachToRow(model, target, travel.leadHand);
      }
      break;
    }

    case 'hanging': {
      const current = rowByKey(holds, model.attachedKey);
      if (!current) {
        beginFall(model);
        break;
      }
      const handCenterX = alignBodyToAttachedHands(model, current);
      model.shimmyDirection = 0;
      if (Number.isFinite(model.routeSearchAboveY)) {
        model.routeRetryElapsed += dt;
        if (model.routeRetryElapsed >= ROUTE_RETRY_DURATION) {
          model.routeSearchAboveY = Number.POSITIVE_INFINITY;
          model.routeRetryElapsed = 0;
        }
      }
      const next = choosePlannedNextHold(
        model,
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
        model.routeSearchAboveY,
      );
      if (!hasConfirmedNextHold(model, next)) {
        // Prefer the text: shimmy laterally along the current row to bring an
        // upper hold within reach, so the climber works the layout instead of
        // ignoring it.
        const traverseX = findTraverseTarget(
          current,
          holds,
          handCenterX,
          cachedMedianRowHeight,
        );
        if (traverseX !== null) {
          model.summitStableElapsed = 0;
          const nextCenter = moveToward(
            handCenterX,
            traverseX,
            SHIMMY_SPEED * dt,
          );
          const traverseDelta = traverseX - handCenterX;
          model.shimmyDirection =
            traverseDelta > 0 ? 1 : traverseDelta < 0 ? -1 : 0;
          model.x = nextCenter - HAND_CENTER_OFFSET_X;
          const handY = attachmentHandY(current);
          for (const side of ['left', 'right'] as const) {
            const anchor = handAnchor(model, side);
            if (anchor.key === current.key) {
              anchor.x = nextCenter + handOffsetX(side);
              anchor.y = handY;
            }
          }
          break;
        }
        // The grapple is a last resort: only when no normal climb step exists
        // anywhere on screen can the rope cross a genuine gap.
        const grappleTarget = chooseGrappleTarget(
          current,
          holds,
          handCenterX,
          cachedMedianRowHeight,
        );
        if (
          grappleTarget &&
          !hasClimbingPathAnywhere(holds, cachedMedianRowHeight)
        ) {
          model.summitStableElapsed = 0;
          startGrapple(model, grappleTarget);
          break;
        }
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
        clearRoutePlan(model);
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
      const shimmyDelta = shimmyHandCenterX - handCenterX;
      model.shimmyDirection =
        shimmyDelta > 0 ? 1 : shimmyDelta < 0 ? -1 : 0;
      const nextHandCenterX = moveToward(
        handCenterX,
        shimmyHandCenterX,
        SHIMMY_SPEED * dt,
      );
      model.x = nextHandCenterX - HAND_CENTER_OFFSET_X;
      model.y = attachmentHandY(current) - HAND_OFFSET_Y;
      for (const side of ['left', 'right'] as const) {
        const anchor = handAnchor(model, side);
        if (anchor.key === current.key) {
          anchor.x = nextHandCenterX + handOffsetX(side);
          anchor.y = attachmentHandY(current);
        }
      }
      if (nextHandCenterX === shimmyHandCenterX) {
        startTravel(model, 'climb', target, CLIMB_DURATION);
      }
      break;
    }

    case 'grappling': {
      const grap = model.grapple;
      const target = rowByKey(holds, grap?.targetKey ?? null);
      if (!grap || !target || !grap.leadHand) {
        beginFall(model);
        break;
      }
      // The hold may have shifted since launch; re-clamp the latch point so a
      // moving text row never yanks the rope past its edge.
      const targetHandX = clamp(
        grap.anchorX,
        minimumHandCenterX(target),
        maximumHandCenterX(target),
      );
      grap.anchorX = targetHandX;
      grap.handEnd.x = targetHandX;
      grap.endX = targetHandX - HAND_CENTER_OFFSET_X - handOffsetX(grap.leadHand);
      grap.handEnd.y = attachmentHandY(target);
      grap.endY = attachmentHandY(target) - HAND_OFFSET_Y;

      grap.elapsed = Math.min(grap.duration, grap.elapsed + dt);
      const progress = smoothstep(grap.elapsed / grap.duration);
      model.phaseElapsed = progress;
      // The grapple respects the text layout: first travel sideways so the
      // body is directly beneath the lowest point of the target row, then reel
      // straight up. (No diagonal zip ignoring the layout.)
      const lateralPhase = 0.5;
      if (progress < lateralPhase) {
        const lateral = smoothstep(progress / lateralPhase);
        model.x = grap.startX + (grap.endX - grap.startX) * lateral;
        model.y = grap.startY;
      } else {
        const vertical = smoothstep(
          (progress - lateralPhase) / (1 - lateralPhase),
        );
        model.x = grap.endX;
        model.y = grap.startY + (grap.endY - grap.startY) * vertical;
      }
      const lead = handAnchor(model, grap.leadHand);
      lead.x = grap.handStart.x + (grap.handEnd.x - grap.handStart.x) * progress;
      lead.y = grap.handStart.y + (grap.handEnd.y - grap.handStart.y) * progress;
      const trailing = handAnchor(model, oppositeHand(grap.leadHand));
      trailing.x = model.x + HAND_CENTER_OFFSET_X + handOffsetX(oppositeHand(grap.leadHand));
      trailing.y = model.y + HAND_OFFSET_Y;

      if (grap.elapsed >= grap.duration) {
        attachToRow(model, target, grap.leadHand);
      }
      break;
    }

    case 'slipping': {
      const slip = model.slip;
      const supportSide = slip ? oppositeHand(slip.side) : 'left';
      const supportAnchor = handAnchor(model, supportSide);
      const supportRow = rowByKey(holds, supportAnchor.key);
      if (!slip || !supportRow || !supportAnchor.key) {
        beginFall(model);
        break;
      }

      slip.elapsed = Math.min(slip.duration, slip.elapsed + dt);
      slip.vy = Math.min(MAX_FALL_SPEED, slip.vy + GRAVITY * dt);
      slip.x += slip.vx * dt;
      slip.y += slip.vy * dt;
      model.x =
        supportAnchor.x -
        HAND_CENTER_OFFSET_X -
        handOffsetX(supportSide);
      model.y = attachmentHandY(supportRow) - HAND_OFFSET_Y;
      supportAnchor.y = attachmentHandY(supportRow);

      if (slip.elapsed >= slip.duration) {
        if (supportRow.rect.width >= MIN_HOLD_WIDTH) {
          attachToRow(model, supportRow, slip.side);
        } else {
          setHandAnchor(model, slip.side, null, slip.x, slip.y);
          model.attachedKey = supportRow.key;
          model.slip = null;
          setMotionState(model, 'hanging');
        }
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
      const next = choosePlannedNextHold(
        model,
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
        Number.POSITIVE_INFINITY,
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
      const next = choosePlannedNextHold(
        model,
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
        Number.POSITIVE_INFINITY,
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
      model.phaseElapsed += dt;
      const next = choosePlannedNextHold(
        model,
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
        Number.POSITIVE_INFINITY,
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
      const next = choosePlannedNextHold(
        model,
        current,
        holds,
        handCenterX,
        cachedMedianRowHeight,
        Number.POSITIVE_INFINITY,
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
