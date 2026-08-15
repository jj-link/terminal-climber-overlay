import { ClimberSimulation, type ClimberState } from './climber';
import type {
  TerminalBackendStatus,
} from './contracts';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

const canvas = requireElement<HTMLCanvasElement>('climber-canvas');

const climberLabels: Record<ClimberState, string> = {
  grounded: 'Grounded',
  launching: 'Launching',
  hanging: 'Hanging',
  shimmying: 'Shimmying',
  climbing: 'Climbing',
  summiting: 'Reaching the summit',
  planting: 'Planting flag',
  camped: 'Camped',
  packing: 'Packing camp',
  falling: 'Falling',
  slipping: 'Slipping',
  landing: 'Landing',
  paused: 'Paused',
};

const simulation = new ClimberSimulation({
  canvas,
  onStateChange: (state) => {
    canvas.setAttribute(
      'aria-label',
      `Terminal Climber ${climberLabels[state.state].toLowerCase()} with ${state.holdCount} visible holds`,
    );
  },
});

window.addEventListener(
  'mousemove',
  (event) => {
    simulation.handlePointerMove(
      { x: event.clientX, y: event.clientY },
      event.timeStamp,
    );
  },
  { passive: true },
);

const api = window.terminalClimberApi;
const cleanupCallbacks: Array<() => void> = [];
if (api) {
  cleanupCallbacks.push(
    api.onCommand((command) => {
      if (command === 'reset') simulation.reset();
    }),
    api.onTerminalSnapshot((snapshot) => {
      simulation.setTerminalSnapshot(snapshot);
    }),
    api.onTerminalStatus((status: TerminalBackendStatus) => {
      simulation.setTerminalStatus(status);
    }),
  );
} else {
  simulation.setTerminalStatus('no-terminal');
}

window.addEventListener(
  'beforeunload',
  () => {
    for (const cleanup of cleanupCallbacks) cleanup();
    simulation.destroy();
  },
  { once: true },
);
