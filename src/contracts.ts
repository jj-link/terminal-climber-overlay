export type TerminalBackendStatus =
  | 'initializing'
  | 'tracking'
  | 'no-terminal'
  | 'unsupported-terminal'
  | 'elevated-terminal'
  | 'backend-error'
  | 'paused';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhysicalTerminalRow {
  index: number;
  signature: string;
  attachable: boolean;
  rectPx: Rect;
}

export interface PhysicalTerminalSnapshot {
  type: 'snapshot';
  targetId: string;
  sampledAt: number;
  viewportRectPx: Rect;
  rows: PhysicalTerminalRow[];
}

export interface TerminalStatusMessage {
  type: 'status';
  status: TerminalBackendStatus;
  reason?: string;
}

export interface RendererTerminalRow {
  index: number;
  signature: string;
  attachable: boolean;
  rect: Rect;
}

export interface RendererTerminalSnapshot {
  targetId: string;
  sampledAt: number;
  displayId: string;
  displayBounds: Rect;
  viewportRect: Rect;
  rows: RendererTerminalRow[];
}

export interface OverlayState {
  clickThrough: boolean;
  paused: boolean;
  alwaysOnTop: boolean;
}

export type OverlayCommand = 'pause-toggle' | 'reset';
