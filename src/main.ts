import { ClimberSimulation, type ClimberState } from './climber';
import type {
  OverlayState,
  TerminalBackendStatus,
} from './contracts';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

function requireSelector<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element ${selector}`);
  return element;
}

const appElement = requireElement<HTMLDivElement>('app');
const canvas = requireElement<HTMLCanvasElement>('climber-canvas');
const backendStatusElement = requireElement<HTMLSpanElement>('backend-status');
const climberStatusElement = requireElement<HTMLSpanElement>('climber-status');
const holdCountElement = requireElement<HTMLOutputElement>('hold-count');
const controlsElement =
  requireSelector<HTMLElement>('.status-controls');
const pauseButton = requireElement<HTMLButtonElement>('pause-button');
const resetButton = requireElement<HTMLButtonElement>('reset-button');
const passthroughButton = requireElement<HTMLButtonElement>('passthrough-button');
const closeButton = requireElement<HTMLButtonElement>('close-button');


const backendLabels: Record<TerminalBackendStatus, string> = {
  initializing: 'Initializing',
  tracking: 'Tracking terminal',
  'no-terminal': 'No terminal',
  'unsupported-terminal': 'Rows unavailable',
  'elevated-terminal': 'Elevated terminal',
  'backend-error': 'Tracker error',
  paused: 'Paused',
};
const climberLabels: Record<ClimberState, string> = {
  grounded: 'Grounded',
  launching: 'Launching',
  hanging: 'Hanging',
  shimmying: 'Shimmying',
  climbing: 'Climbing',
  falling: 'Falling',
  landing: 'Landing',
  paused: 'Paused',
};

let clickThrough = true;
let paused = false;
let reportedBackendStatus: TerminalBackendStatus = 'initializing';
const cleanupCallbacks: Array<() => void> = [];

function renderBackendStatus(): void {
  const visibleStatus: TerminalBackendStatus = paused
    ? 'paused'
    : reportedBackendStatus;
  appElement.dataset.backendStatus = visibleStatus;
  backendStatusElement.textContent = backendLabels[visibleStatus];
}

function renderOverlayState(state: OverlayState): void {
  clickThrough = state.clickThrough;
  paused = state.paused;
  appElement.dataset.clickThrough = String(clickThrough);
  controlsElement.inert = clickThrough;

  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.setAttribute(
    'aria-label',
    paused ? 'Resume Terminal Climber' : 'Pause Terminal Climber',
  );
  pauseButton.title = paused
    ? 'Resume (Ctrl+Alt+Shift+P)'
    : 'Pause (Ctrl+Alt+Shift+P)';

  passthroughButton.setAttribute('aria-pressed', String(clickThrough));
  passthroughButton.setAttribute(
    'aria-label',
    clickThrough ? 'Mouse passthrough enabled' : 'Mouse controls active',
  );
  const passthroughLabel = passthroughButton.querySelector<HTMLElement>(
    '.control-label',
  );
  if (passthroughLabel) {
    passthroughLabel.textContent = clickThrough ? 'Mouse pass' : 'Mouse active';
  }

  simulation.setPaused(paused);
  renderBackendStatus();
}

const simulation = new ClimberSimulation({
  canvas,
  onStateChange: (state) => {
    appElement.dataset.climberState = state.state;
    appElement.dataset.holdCount = String(state.holdCount);
    climberStatusElement.textContent = climberLabels[state.state];
    holdCountElement.value = String(state.holdCount);
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

pauseButton.addEventListener('click', () => {
  if (window.terminalClimberApi) {
    window.terminalClimberApi.setPaused(!paused);
  } else {
    renderOverlayState({ clickThrough, paused: !paused, alwaysOnTop: false });
  }
});

resetButton.addEventListener('click', () => {
  if (window.terminalClimberApi) window.terminalClimberApi.reset();
  else simulation.reset();
});

passthroughButton.addEventListener('click', () => {
  if (window.terminalClimberApi) {
    window.terminalClimberApi.setClickThrough(!clickThrough);
  } else {
    renderOverlayState({ clickThrough: !clickThrough, paused, alwaysOnTop: false });
  }
});

closeButton.addEventListener('click', () => {
  if (window.terminalClimberApi) window.terminalClimberApi.quit();
  else window.close();
});

const api = window.terminalClimberApi;
if (api) {
  cleanupCallbacks.push(
    api.onStateChanged(renderOverlayState),
    api.onTerminalSnapshot((snapshot) => {
      simulation.setTerminalSnapshot(snapshot);
    }),
    api.onTerminalStatus((status) => {
      if (status !== 'paused') reportedBackendStatus = status;
      simulation.setTerminalStatus(status);
      renderBackendStatus();
    }),
    api.onCommand((command) => {
      if (command === 'reset') simulation.reset();
      if (command === 'pause-toggle') simulation.setPaused(!paused);
    }),
  );
  void api.getState().then(renderOverlayState).catch(() => {
    reportedBackendStatus = 'backend-error';
    simulation.setTerminalStatus('backend-error');
    renderBackendStatus();
  });
} else {
  reportedBackendStatus = 'no-terminal';
  simulation.setTerminalStatus('no-terminal');
  renderBackendStatus();
}

window.addEventListener(
  'beforeunload',
  () => {
    for (const cleanup of cleanupCallbacks) cleanup();
    simulation.destroy();
  },
  { once: true },
);
