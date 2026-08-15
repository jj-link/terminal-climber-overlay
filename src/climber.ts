/**
 * Public facade for the climber simulation. All public API surfaces are
 * re-exported here; internal modules are implementation boundaries.
 */
export { ClimberSimulation } from './climber-simulation';
export type {
  ClimberState,
  Point,
  HandSide,
  HandAnchor,
  HandSlip,
  ClimberMotionModel,
  ClimberMotionEnvironment,
} from './climber-model';
export type {
  ClimberObservableState,
  ClimberSimulationOptions,
} from './climber-simulation';

export {
  SPRITE_WIDTH,
  SPRITE_HEIGHT,
  GRAVITY,
  MAX_FALL_SPEED,
  SHIMMY_SPEED,
  SLIP_DURATION,
  ROUTE_LOOKAHEAD_DEPTH,
  CLIMB_DURATION,
  LAUNCH_DURATION,
  LANDING_RECOVERY,
  POINTER_BUMP_SPEED,
  BUMP_IMPULSE_FACTOR,
  MAX_BUMP_IMPULSE,
  STATUS_GRACE_MS,
  TARGET_CONFIRM_SNAPSHOTS,
  ROUTE_RETRY_DURATION,
  SUMMIT_STABILITY_DURATION,
  SUMMIT_MANTLE_DURATION,
  FLAG_PLANT_DURATION,
  CAMP_PACK_DURATION,
  HAND_SPREAD,
  HAND_OFFSET_Y,
  HOLD_INSET,
} from './climber-model';
export { isUsableHandHold, isUsableClimberHold } from './climber-geometry';
export { reduceClimberMotion } from './climber-motion';
export { selectClimberSpriteCell } from './climber-renderer';
