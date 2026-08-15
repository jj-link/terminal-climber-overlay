'use strict';

/**
 * Startup orchestration helpers.
 *
 * Extracted so the shortcut registration → window creation pipeline
 * can be unit-tested with injected (mock) Electron dependencies
 * instead of requiring a full Electron instance.
 */

/**
 * Acquire the single-instance lock and return structured results.
 *
 * @param {Object} appApi — Electron app-like API with requestSingleInstanceLock() and quit()
 * @param {Function} onSecondInstance — callback to run when a second instance launches
 * @returns {Object} { gotLock: boolean, quitCalled: boolean }
 */
function acquireSingleInstanceLock(appApi, onSecondInstance) {
  const gotLock = appApi.requestSingleInstanceLock();
  if (!gotLock) {
    appApi.quit();
    return { gotLock: false, quitCalled: true };
  }
  appApi.on('second-instance', onSecondInstance);
  return { gotLock: true, quitCalled: false };
}

/**
 * Present an existing overlay after a second launch without stealing terminal
 * keyboard focus while the overlay is in click-through mode.
 *
 * @param {Object|null} window - BrowserWindow-like object
 * @param {boolean} clickThrough - canonical mouse passthrough state
 * @returns {boolean} true when a live window was activated
 */
function activateOverlayWindow(window, clickThrough) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (clickThrough) {
    window.showInactive();
    window.blur();
  } else {
    window.show();
    window.focus();
  }
  return true;
}

/** Synchronize a newly created worker with canonical pause state. */
function synchronizeWorkerPause(worker, paused) {
  if (!worker) return false;
  worker.postMessage({ type: 'pause', paused: Boolean(paused) });
  return true;
}

/**
 * Build the conflict dialog options from registration failures.
 *
 * @param {Array<Object>} failures — registerControls failure entries
 * @returns {Object} dialog options matching dialog.showMessageBox config
 */
function buildConflictDialogOptions(failures) {
  const conflictList = failures
    .map((f) => f.accelerator)
    .join('\n  - ');
  return {
    type: 'warning',
    title: 'Terminal Climber — Shortcut Conflicts',
    message:
      'One or more global shortcuts could not be registered. '
      + 'Another application may be using the same keys.',
    detail:
      'Conflicting shortcuts:\n  - ' + conflictList + '\n\n'
      + 'The overlay will keep running; close it from Task Manager if you cannot press the shortcut.',
    buttons: ['OK'],
  };
}

/**
 * Run the full shortcut registration and window bootstrap sequence.
 *
 * @param {Object} opts
 * @param {Object} opts.shortcutApi — globalShortcut-compatible API
 * @param {Object} opts.handlers — shortcut callback map for registerControls
 * @param {Function} opts.registerControls — the registerControls function from global-controls.cjs
 * @param {Function} opts.showMessageBox — dialog.showMessageBox (optional, called on failures)
 * @param {Function} opts.createOverlayWindow — callback(initialClickThrough) to create the window
 * @param {Function} opts.startTerminalWorker — callback to start the polling worker
 * @param {Function} opts.onDisplayMetricsChanged — display-metrics-changed handler
 * @param {Function} opts.onDisplayAdded — display-added handler
 * @param {Function} opts.onDisplayRemoved — display-removed handler
 * @param {Object} opts.screenApi — Electron screen API (for display event listeners)
 * @returns {Object} results with passthroughAvailable, initialClickThrough, failures, dialogShown
 */
async function bootstrapOverlay(opts) {
  const {
    shortcutApi,
    handlers,
    registerControls,
    showMessageBox,
    createOverlayWindow,
    startTerminalWorker,
    onDisplayMetricsChanged,
    onDisplayAdded,
    onDisplayRemoved,
    screenApi,
  } = opts;

  const regResults = registerControls(shortcutApi, handlers);

  const passthroughAvailable = regResults.passthroughAvailable;
  const initialClickThrough = regResults.allRegistered;
  let dialogShown = false;

  if (regResults.failures.length > 0 && typeof showMessageBox === 'function') {
    const dialogOpts = buildConflictDialogOptions(regResults.failures);
    try {
      await showMessageBox(dialogOpts);
      dialogShown = true;
    } catch {
      // Dialog rejected or error — continue startup in safe mode and report
      // that no warning was successfully presented.
    }
  }

  createOverlayWindow(initialClickThrough);

  if (screenApi) {
    screenApi.on('display-metrics-changed', onDisplayMetricsChanged);
    screenApi.on('display-added', onDisplayAdded);
    screenApi.on('display-removed', onDisplayRemoved);
  }

  startTerminalWorker();

  return {
    passthroughAvailable,
    initialClickThrough,
    failures: regResults.failures,
    dialogShown,
  };
}

/**
 * Derive the initial click-through policy from registration results.
 *
 * @param {Object} regResults — return value from registerControls
 * @returns {boolean} true if click-through should be enabled initially
 */
function deriveInitialClickThrough(regResults) {
  return regResults.allRegistered;
}

module.exports = {
  acquireSingleInstanceLock,
  activateOverlayWindow,
  buildConflictDialogOptions,
  bootstrapOverlay,
  synchronizeWorkerPause,
  deriveInitialClickThrough,
};
