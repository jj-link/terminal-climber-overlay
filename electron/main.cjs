'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  dialog,
} = require('electron');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { registerControls } = require('./global-controls.cjs');
const {
  allowClickThroughChange,
  applyClickThroughToWindow,
} = require('./clickthrough-policy.cjs');
const {
  acquireSingleInstanceLock,
  activateOverlayWindow,
  bootstrapOverlay,
  synchronizeWorkerPause,
} = require('./startup.cjs');

const CHANNELS = Object.freeze({
  overlayState: 'overlay:state',
  getOverlayState: 'overlay:get-state',
  setClickThrough: 'overlay:set-click-through',
  setPaused: 'overlay:set-paused',
  reset: 'overlay:reset',
  command: 'overlay:command',
  quit: 'overlay:quit',
  terminalSnapshot: 'terminal:snapshot',
  terminalStatus: 'terminal:status',
});
const BACKEND_STATUSES = new Set([
  'initializing',
  'tracking',
  'no-terminal',
  'unsupported-terminal',
  'elevated-terminal',
  'backend-error',
  'paused',
]);
const WORKER_PATH = path.join(__dirname, 'terminal-uia-worker.cjs');
const PROBE_MODE = process.argv.includes('--uia-probe');
const PROBE_TIMEOUT_MS = 10_000;
const SNAPSHOT_INTERVAL_MS = 1000 / 30;

let overlayWindow = null;
let terminalWorker = null;
let workerRestartTimer = null;
let workerCrashCount = 0;
let workerGeneration = 0;
let shuttingDown = false;
let quitReady = false;
let clickThrough = true;
let paused = false;
let passthroughAvailable = true;
let activeDisplayId = null;
let lastPhysicalSnapshot = null;
let lastRendererSnapshot = null;
let lastTerminalStatus = {
  type: 'status',
  status: 'initializing',
};
let pendingRendererSnapshot = null;
let pendingSnapshotTimer = null;
let lastSnapshotSentAt = 0;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finitePositiveRect(rect) {
  return (
    isObject(rect) &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function finiteNonnegativeRect(rect) {
  return (
    isObject(rect) &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function toElectronRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function sanitizeReason(reason) {
  return typeof reason === 'string' && /^[a-z0-9-]{1,96}$/i.test(reason)
    ? reason
    : undefined;
}

function sanitizeStatusMessage(value) {
  if (!isObject(value) || value.type !== 'status') return null;
  if (!BACKEND_STATUSES.has(value.status)) return null;
  const reason = sanitizeReason(value.reason);
  return reason
    ? { type: 'status', status: value.status, reason }
    : { type: 'status', status: value.status };
}

function sanitizePhysicalSnapshot(value) {
  const targetMatch =
    typeof value?.targetId === 'string'
      ? /^(\d+):(?:0x)?([0-9a-f]+)$/i.exec(value.targetId)
      : null;
  if (
    !isObject(value) ||
    value.type !== 'snapshot' ||
    !targetMatch ||
    !Number.isFinite(value.sampledAt) ||
    !finitePositiveRect(value.viewportRectPx) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 10_000
  ) {
    return null;
  }

  const rows = [];
  let previousIndex = -1;
  let previousSegmentIndex = -1;
  for (let position = 0; position < value.rows.length; position += 1) {
    const row = value.rows[position];
    if (
      !isObject(row) ||
      !Number.isSafeInteger(row.index) ||
      !Number.isSafeInteger(row.segmentIndex) ||
      (position === 0
        ? row.index !== 0 || row.segmentIndex !== 0
        : !(
            (row.index === previousIndex &&
              row.segmentIndex === previousSegmentIndex + 1) ||
            (row.index === previousIndex + 1 && row.segmentIndex === 0)
          )) ||
      typeof row.signature !== 'string' ||
      !/^[0-9a-f]{16}$/i.test(row.signature) ||
      typeof row.attachable !== 'boolean' ||
      !finiteNonnegativeRect(row.rectPx) ||
      (row.attachable && !finitePositiveRect(row.rectPx))
    ) {
      return null;
    }
    previousIndex = row.index;
    previousSegmentIndex = row.segmentIndex;
    rows.push({
      index: row.index,
      segmentIndex: row.segmentIndex,
      signature: row.signature.toLowerCase(),
      attachable: row.attachable,
      rectPx: {
        x: row.rectPx.x,
        y: row.rectPx.y,
        width: row.rectPx.width,
        height: row.rectPx.height,
      },
    });
  }

  return {
    type: 'snapshot',
    targetId: `${targetMatch[1]}:0x${targetMatch[2].toLowerCase()}`,
    sampledAt: value.sampledAt,
    viewportRectPx: {
      x: value.viewportRectPx.x,
      y: value.viewportRectPx.y,
      width: value.viewportRectPx.width,
      height: value.viewportRectPx.height,
    },
    rows,
  };
}

function overlayState() {
  return {
    clickThrough,
    paused,
    alwaysOnTop: overlayWindow?.isAlwaysOnTop() ?? false,
    passthroughAvailable,
  };
}

function sendRenderer(channel, payload) {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    overlayWindow.webContents.isDestroyed()
  ) {
    return;
  }
  overlayWindow.webContents.send(channel, payload);
}

function broadcastState() {
  sendRenderer(CHANNELS.overlayState, overlayState());
}

function broadcastTerminalStatus(message) {
  lastTerminalStatus = message;
  sendRenderer(CHANNELS.terminalStatus, message);
}

function reportBackendStatus(status, reason) {
  const message = sanitizeStatusMessage({ type: 'status', status, reason });
  if (message) broadcastTerminalStatus(message);
}

function flushPendingSnapshot() {
  pendingSnapshotTimer = null;
  if (!pendingRendererSnapshot) return;
  lastRendererSnapshot = pendingRendererSnapshot;
  pendingRendererSnapshot = null;
  lastSnapshotSentAt = Date.now();
  sendRenderer(CHANNELS.terminalSnapshot, lastRendererSnapshot);
}

function queueRendererSnapshot(snapshot) {
  pendingRendererSnapshot = snapshot;
  const elapsed = Date.now() - lastSnapshotSentAt;
  if (elapsed >= SNAPSHOT_INTERVAL_MS) {
    if (pendingSnapshotTimer) {
      clearTimeout(pendingSnapshotTimer);
      pendingSnapshotTimer = null;
    }
    flushPendingSnapshot();
    return;
  }
  if (!pendingSnapshotTimer) {
    pendingSnapshotTimer = setTimeout(
      flushPendingSnapshot,
      Math.max(1, Math.ceil(SNAPSHOT_INTERVAL_MS - elapsed)),
    );
  }
}

function sameBounds(left, right) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function localizeRect(rect, displayBounds) {
  return {
    x: rect.x - displayBounds.x,
    y: rect.y - displayBounds.y,
    width: rect.width,
    height: rect.height,
  };
}

function convertPhysicalSnapshot(snapshot) {
  const viewportDip = screen.screenToDipRect(
    null,
    toElectronRect(snapshot.viewportRectPx),
  );
  const display = screen.getDisplayMatching(viewportDip);
  const displayId = String(display.id);
  const displayChanged = activeDisplayId !== null && activeDisplayId !== displayId;
  activeDisplayId = displayId;

  if (
    overlayWindow &&
    !overlayWindow.isDestroyed() &&
    !sameBounds(overlayWindow.getBounds(), display.bounds)
  ) {
    overlayWindow.setBounds(display.bounds, false);
  }
  if (displayChanged) {
    sendRenderer(CHANNELS.command, 'reset');
  }

  const rows = snapshot.rows.map((row) => {
    const rect = finitePositiveRect(row.rectPx)
      ? localizeRect(
          screen.screenToDipRect(null, toElectronRect(row.rectPx)),
          display.bounds,
        )
      : { x: 0, y: 0, width: 0, height: 0 };
    return {
      index: row.index,
      segmentIndex: row.segmentIndex,
      signature: row.signature,
      attachable: row.attachable,
      rect,
    };
  });

  return {
    targetId: snapshot.targetId,
    sampledAt: snapshot.sampledAt,
    displayId,
    displayBounds: {
      x: 0,
      y: 0,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    viewportRect: localizeRect(viewportDip, display.bounds),
    rows,
  };
}

function acceptPhysicalSnapshot(snapshot) {
  try {
    const converted = convertPhysicalSnapshot(snapshot);
    lastPhysicalSnapshot = snapshot;
    if (lastTerminalStatus.status !== 'tracking') {
      broadcastTerminalStatus({ type: 'status', status: 'tracking' });
    }
    queueRendererSnapshot(converted);
  } catch {
    reportBackendStatus('backend-error', 'geometry-conversion-failed');
  }
}

function handleWorkerMessage(value) {
  const status = sanitizeStatusMessage(value);
  if (status) {
    broadcastTerminalStatus(status);
    return;
  }

  const snapshot = sanitizePhysicalSnapshot(value);
  if (!snapshot) {
    reportBackendStatus('backend-error', 'malformed-worker-message');
    return;
  }
  acceptPhysicalSnapshot(snapshot);
}

function handleWorkerFailure(worker, generation) {
  if (
    shuttingDown ||
    worker !== terminalWorker ||
    generation !== workerGeneration
  ) {
    return;
  }
  terminalWorker = null;
  if (workerCrashCount >= 1) {
    reportBackendStatus('backend-error', 'worker-crashed-twice');
    return;
  }
  workerCrashCount += 1;
  reportBackendStatus('initializing', 'worker-restarting');
  workerRestartTimer = setTimeout(() => {
    workerRestartTimer = null;
    startTerminalWorker();
  }, 1000);
}

function startTerminalWorker() {
  if (shuttingDown || terminalWorker) return;
  const generation = ++workerGeneration;
  let worker;
  try {
    worker = new Worker(WORKER_PATH);
  } catch {
    handleWorkerFailure(null, generation);
    return;
  }

  terminalWorker = worker;
  // A pause shortcut can fire while startup awaits the conflict dialog. New
  // workers must inherit the canonical state instead of their default.
  synchronizeWorkerPause(worker, paused);
  let failureHandled = false;
  const failOnce = () => {
    if (failureHandled) return;
    failureHandled = true;
    handleWorkerFailure(worker, generation);
  };
  worker.on('message', handleWorkerMessage);
  worker.once('error', failOnce);
  worker.once('exit', () => {
    if (!shuttingDown) failOnce();
  });
}

function stopWorker(worker) {
  if (!worker) return Promise.resolve();
  if (worker === terminalWorker) terminalWorker = null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      worker.terminate().then(finish, finish);
    }, 750);
    worker.once('exit', finish);
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      worker.terminate().then(finish, finish);
    }
  });
}

function setClickThrough(enabled) {
  const next = Boolean(enabled);
  // If the passthrough shortcut is unavailable, prevent enabling
  // click-through — there would be no keyboard recovery path.
  if (!allowClickThroughChange(next, passthroughAvailable)) {
    broadcastState();
    return;
  }
  clickThrough = next;
  // Always synchronize a live window, even if the canonical value did not
  // change. A shortcut can fire before window creation and leave the new
  // BrowserWindow's native ignore-mouse default out of sync.
  applyClickThroughToWindow(overlayWindow, clickThrough);
  broadcastState();
}

function setPaused(enabled) {
  const next = Boolean(enabled);
  if (next === paused) {
    broadcastState();
    return;
  }
  paused = next;
  terminalWorker?.postMessage({ type: 'pause', paused });
  sendRenderer(CHANNELS.command, 'pause-toggle');
  broadcastState();
}

function resetClimber() {
  sendRenderer(CHANNELS.command, 'reset');
}

function sendInitialRendererState() {
  broadcastState();
  sendRenderer(CHANNELS.terminalStatus, lastTerminalStatus);
  if (lastRendererSnapshot) {
    sendRenderer(CHANNELS.terminalSnapshot, lastRendererSnapshot);
  }
}

function createOverlayWindow(initialClickThrough) {
  const bounds = screen.getPrimaryDisplay().bounds;
  activeDisplayId = String(screen.getPrimaryDisplay().id);
  overlayWindow = new BrowserWindow({
    ...bounds,
    title: 'Terminal Climber',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) overlayWindow.loadURL(developmentUrl);
  else overlayWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  overlayWindow.once('ready-to-show', () => overlayWindow?.showInactive());
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayWindow.webContents.on('did-finish-load', sendInitialRendererState);
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = overlayWindow?.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });

  // Apply initial mouse interaction policy after window is created.
  // The window must exist before setClickThrough can set ignore-mouse.
  setClickThrough(initialClickThrough);
}



function refreshDisplayGeometry() {
  if (!lastPhysicalSnapshot) return;
  sendRenderer(CHANNELS.command, 'reset');
  try {
    queueRendererSnapshot(convertPhysicalSnapshot(lastPhysicalSnapshot));
  } catch {
    reportBackendStatus('backend-error', 'geometry-conversion-failed');
  }
}

function probeTerminalWorker() {
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let latestStatus = 'initializing';
    let timeout;

    const finish = (result, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ worker, result, exitCode });
    };

    try {
      worker = new Worker(WORKER_PATH);
    } catch {
      finish(
        {
          status: 'backend-error',
          targetId: null,
          attachableRows: 0,
          sampleRects: [],
        },
        1,
      );
      return;
    }

    worker.on('message', (value) => {
      const status = sanitizeStatusMessage(value);
      if (status) {
        latestStatus = status.status;
        if (
          status.status === 'backend-error' ||
          status.status === 'elevated-terminal'
        ) {
          finish(
            {
              status: status.status,
              targetId: null,
              attachableRows: 0,
              sampleRects: [],
            },
            1,
          );
        }
        return;
      }

      const snapshot = sanitizePhysicalSnapshot(value);
      if (!snapshot) {
        finish(
          {
            status: 'backend-error',
            targetId: null,
            attachableRows: 0,
            sampleRects: [],
          },
          1,
        );
        return;
      }
      const attachableRows = snapshot.rows.filter(
        (row) => row.attachable && finitePositiveRect(row.rectPx),
      );
      if (attachableRows.length < 3) return;
      finish(
        {
          status: 'tracking',
          targetId: snapshot.targetId,
          attachableRows: attachableRows.length,
          sampleRects: attachableRows.slice(0, 3).map((row) => row.rectPx),
        },
        0,
      );
    });
    worker.once('error', () => {
      finish(
        {
          status: 'backend-error',
          targetId: null,
          attachableRows: 0,
          sampleRects: [],
        },
        1,
      );
    });
    worker.once('exit', () => {
      finish(
        {
          status: 'backend-error',
          targetId: null,
          attachableRows: 0,
          sampleRects: [],
        },
        1,
      );
    });

    timeout = setTimeout(() => {
      finish(
        {
          status: latestStatus,
          targetId: null,
          attachableRows: 0,
          sampleRects: [],
        },
        1,
      );
    }, PROBE_TIMEOUT_MS);
  });
}

async function executeProbe() {
  const { worker, result, exitCode } = await probeTerminalWorker();
  await stopWorker(worker);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(exitCode);
}

// Single-instance guard — exempt from PROBE_MODE so multiple probes can
// be launched independently while the overlay is running.
if (!PROBE_MODE) {
  const secondInstanceHandler = () => {
    activateOverlayWindow(overlayWindow, clickThrough);
  };
  acquireSingleInstanceLock(app, secondInstanceHandler);
}

app.whenReady().then(async () => {
  if (PROBE_MODE) {
    await executeProbe();
    return;
  }

  // Delegate shortcut registration, dialog, window creation, and worker
  // startup to the extracted orchestration helper so that the same code
  // path is covered by unit tests (tests/startup-orchestration.test.ts).
  const result = await bootstrapOverlay({
    shortcutApi: globalShortcut,
    handlers: {
      togglePassthrough: () => setClickThrough(!clickThrough),
      togglePause: () => setPaused(!paused),
      resetClimber,
    },
    registerControls,
    showMessageBox: dialog.showMessageBox.bind(dialog),
    createOverlayWindow,
    startTerminalWorker,
    onDisplayMetricsChanged: refreshDisplayGeometry,
    onDisplayAdded: refreshDisplayGeometry,
    onDisplayRemoved: refreshDisplayGeometry,
    screenApi: screen,
  });

  // Track passthrough recovery availability so the IPC handler can
  // reject unsafe click-through transitions.
  passthroughAvailable = result.passthroughAvailable;
});

ipcMain.handle(CHANNELS.getOverlayState, () => overlayState());
ipcMain.on(CHANNELS.setClickThrough, (_event, enabled) => {
  setClickThrough(enabled);
});
ipcMain.on(CHANNELS.setPaused, (_event, enabled) => {
  setPaused(enabled);
});
ipcMain.on(CHANNELS.reset, resetClimber);
ipcMain.on(CHANNELS.quit, () => app.quit());

app.on('before-quit', (event) => {
  if (PROBE_MODE || quitReady || (!terminalWorker && !workerRestartTimer)) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  if (workerRestartTimer) {
    clearTimeout(workerRestartTimer);
    workerRestartTimer = null;
  }
  stopWorker(terminalWorker).finally(() => {
    quitReady = true;
    app.quit();
  });
});

app.on('will-quit', () => {
  shuttingDown = true;
  clearTimeout(pendingSnapshotTimer);
  pendingSnapshotTimer = null;
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
