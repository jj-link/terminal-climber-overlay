'use strict';

/**
 * Click-through policy guard.
 *
 * When the passthrough shortcut is unavailable (registration failed),
 * enabling click-through would leave no keyboard recovery path.
 * This guard rejects such transitions.
 *
 * @param enabled - requested next click-through state
 * @param passthroughAvailable - whether the toggle-passthrough shortcut was registered
 * @returns true if the transition is allowed, false if rejected
 */
function allowClickThroughChange(enabled, passthroughAvailable) {
  if (enabled && !passthroughAvailable) return false;
  return true;
}

/**
 * Synchronize an existing window with the canonical click-through state.
 * This intentionally applies the native policy even when the state value did
 * not change, because a newly created window may still have stale defaults.
 *
 * @param {Object|null} window - BrowserWindow-like object
 * @param {boolean} enabled - canonical click-through state
 * @returns {boolean} true when a live window was synchronized
 */
function applyClickThroughToWindow(window, enabled) {
  if (!window || window.isDestroyed()) return false;
  window.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
  if (enabled) {
    window.blur();
    window.showInactive();
  } else {
    window.show();
    window.focus();
  }
  return true;
}

module.exports = { allowClickThroughChange, applyClickThroughToWindow };
