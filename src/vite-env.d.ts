/// <reference types="vite/client" />

import type {
  OverlayCommand,
  RendererTerminalSnapshot,
  TerminalBackendStatus,
} from './contracts';

declare global {
  interface Window {
    terminalClimberApi?: {
      isDesktop: true;
      onCommand(callback: (command: OverlayCommand) => void): () => void;
      onTerminalSnapshot(callback: (snapshot: RendererTerminalSnapshot) => void): () => void;
      onTerminalStatus(
        callback: (status: TerminalBackendStatus, reason?: string) => void,
      ): () => void;
    };
  }
}

export {};
