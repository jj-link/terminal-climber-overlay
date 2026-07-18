/// <reference types="vite/client" />

import type {
  OverlayCommand,
  OverlayState,
  RendererTerminalSnapshot,
  TerminalBackendStatus,
} from './contracts';

declare global {
  interface Window {
    terminalClimberApi?: {
      isDesktop: true;
      getState(): Promise<OverlayState>;
      setClickThrough(enabled: boolean): void;
      setPaused(paused: boolean): void;
      reset(): void;
      quit(): void;
      onStateChanged(callback: (state: OverlayState) => void): () => void;
      onTerminalSnapshot(callback: (snapshot: RendererTerminalSnapshot) => void): () => void;
      onTerminalStatus(
        callback: (status: TerminalBackendStatus, reason?: string) => void,
      ): () => void;
      onCommand(callback: (command: OverlayCommand) => void): () => void;
    };
  }
}

export {};
