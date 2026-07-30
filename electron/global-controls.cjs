'use strict';

const ACCELERATORS = Object.freeze({
  togglePassthrough: 'CommandOrControl+Shift+O',
  togglePause: 'CommandOrControl+Alt+Shift+P',
  resetClimber: 'CommandOrControl+Alt+Shift+R',
});

/**
 * Register global shortcuts and return structured results.
 *
 * @param {Object} shortcutApi — globalShortcut-compatible API (register/unregisterAll)
 * @param {Object} handlers    — callback functions keyed by control name
 * @returns {Object} registration results with per-control success/failure details
 */
function registerControls(shortcutApi, handlers) {
  const results = [];
  const controlNames = Object.keys(ACCELERATORS);

  for (const name of controlNames) {
    const accelerator = ACCELERATORS[name];
    const handler = handlers[name];

    if (typeof handler !== 'function') {
      results.push({
        name,
        accelerator,
        success: false,
        error: 'missing callback handler',
      });
      continue;
    }

    try {
      const registered = shortcutApi.register(accelerator, handler);
      results.push({
        name,
        accelerator,
        success: registered,
        error: null,
      });
    } catch (err) {
      results.push({
        name,
        accelerator,
        success: false,
        error: String(err?.message ?? err),
      });
    }
  }

  return {
    results,
    allRegistered: results.every((r) => r.success),
    passthroughAvailable: results.find(
      (r) => r.name === 'togglePassthrough'
    )?.success ?? false,
    failures: results.filter((r) => !r.success),
  };
}

module.exports = { ACCELERATORS, registerControls };
