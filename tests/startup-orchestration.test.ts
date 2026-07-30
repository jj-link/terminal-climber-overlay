import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  acquireSingleInstanceLock,
  activateOverlayWindow,
  buildConflictDialogOptions,
  bootstrapOverlay,
  deriveInitialClickThrough,
  synchronizeWorkerPause,
} = require('../electron/startup.cjs');
const { registerControls } = require('../electron/global-controls.cjs');

describe('startup — single-instance lock', () => {
  it('calls app.quit() when the lock is denied', () => {
    const quitFn = vi.fn();
    const appApi = {
      requestSingleInstanceLock: vi.fn().mockReturnValue(false),
      quit: quitFn,
      on: vi.fn(),
    };

    const result = acquireSingleInstanceLock(appApi, () => {});

    expect(result.gotLock).toBe(false);
    expect(result.quitCalled).toBe(true);
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(appApi.on).not.toHaveBeenCalled();
  });

  it('registers second-instance handler when the lock is acquired', () => {
    const secondInstanceFn = vi.fn();
    const onFn = vi.fn();
    const appApi = {
      requestSingleInstanceLock: vi.fn().mockReturnValue(true),
      quit: vi.fn(),
      on: onFn,
    };

    const result = acquireSingleInstanceLock(appApi, secondInstanceFn);

    expect(result.gotLock).toBe(true);
    expect(result.quitCalled).toBe(false);
    expect(onFn).toHaveBeenCalledWith('second-instance', secondInstanceFn);
  });
});

describe('startup — second-instance window activation', () => {
  function createWindow({ destroyed = false, minimized = false } = {}) {
    return {
      isDestroyed: vi.fn().mockReturnValue(destroyed),
      isMinimized: vi.fn().mockReturnValue(minimized),
      restore: vi.fn(),
      show: vi.fn(),
      showInactive: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
    };
  }

  it('focuses an interactive overlay', () => {
    const window = createWindow();

    expect(activateOverlayWindow(window, false)).toBe(true);

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it('preserves inactive presentation for a click-through overlay', () => {
    const window = createWindow();

    expect(activateOverlayWindow(window, true)).toBe(true);

    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.blur).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it('restores a minimized window before presenting it', () => {
    const window = createWindow({ minimized: true });

    activateOverlayWindow(window, true);

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.showInactive).toHaveBeenCalledTimes(1);
  });

  it('does nothing for absent or destroyed windows', () => {
    const window = createWindow({ destroyed: true });

    expect(activateOverlayWindow(null, false)).toBe(false);
    expect(activateOverlayWindow(window, false)).toBe(false);
    expect(window.isMinimized).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});

describe('startup — conflict dialog options', () => {
  it('builds a warning dialog with the correct accelerators', () => {
    const failures = [
      { name: 'togglePassthrough', accelerator: 'CommandOrControl+Shift+O' },
      { name: 'togglePause', accelerator: 'CommandOrControl+Alt+Shift+P' },
    ];

    const opts = buildConflictDialogOptions(failures);

    expect(opts.type).toBe('warning');
    expect(opts.title).toBe('Terminal Climber — Shortcut Conflicts');
    expect(opts.message).toContain('shortcuts could not be registered');
    expect(opts.detail).toContain('CommandOrControl+Shift+O');
    expect(opts.detail).toContain('CommandOrControl+Alt+Shift+P');
    expect(opts.buttons).toEqual(['OK']);
  });

  it('handles a single failure', () => {
    const failures = [
      { name: 'togglePassthrough', accelerator: 'CommandOrControl+Shift+O' },
    ];

    const opts = buildConflictDialogOptions(failures);

    expect(opts.detail).toContain('CommandOrControl+Shift+O');
  });

  it('handles empty failures array gracefully', () => {
    const opts = buildConflictDialogOptions([]);

    expect(opts.type).toBe('warning');
    expect(opts.detail).toContain('\n  - ');
  });
});

describe('startup — bootstrapOverlay', () => {
  function createShortcutApi(...returnValues: boolean[]) {
    const callIterator = returnValues[Symbol.iterator]();
    return {
      register: vi.fn(() => {
        const next = callIterator.next();
        return next.value;
      }),
    };
  }

  it('creates the window with click-through enabled when all shortcuts register', async () => {
    const createWindow = vi.fn();
    const startWorker = vi.fn();

    await bootstrapOverlay({
      shortcutApi: createShortcutApi(true, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: vi.fn(),
      createOverlayWindow: createWindow,
      startTerminalWorker: startWorker,
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    // All shortcuts registered → click-through ON (ignore mouse, use keyboard).
    expect(createWindow).toHaveBeenCalledWith(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
  });

  it('creates the window with click-through disabled when passthrough fails', async () => {
    const createWindow = vi.fn();
    const showBox = vi.fn();

    await bootstrapOverlay({
      shortcutApi: createShortcutApi(false, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: showBox,
      createOverlayWindow: createWindow,
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    // Shortcuts failed → click-through OFF (direct mouse control).
    expect(createWindow).toHaveBeenCalledWith(false);
    expect(showBox).toHaveBeenCalledTimes(1);
  });

  it('creates the window with click-through disabled when non-passthrough shortcuts fail', async () => {
    const createWindow = vi.fn();
    const showBox = vi.fn();

    await bootstrapOverlay({
      shortcutApi: createShortcutApi(true, false, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: showBox,
      createOverlayWindow: createWindow,
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    // Any shortcut failed → click-through OFF (direct mouse control).
    expect(createWindow).toHaveBeenCalledWith(false);
    expect(showBox).toHaveBeenCalledTimes(1);
  });

  it('continues startup when showMessageBox throws', async () => {
    const createWindow = vi.fn();
    const startWorker = vi.fn();
    const showBox = vi.fn().mockRejectedValue(new Error('dialog error'));

    const result = await bootstrapOverlay({
      shortcutApi: createShortcutApi(false, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: showBox,
      createOverlayWindow: createWindow,
      startTerminalWorker: startWorker,
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    // Startup should proceed despite dialog failure.
    expect(createWindow).toHaveBeenCalledWith(false);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(result.dialogShown).toBe(false);
  });

  it('synchronizes a worker when pause is toggled while the dialog is pending', async () => {
    let resolveDialog: (value: unknown) => void;
    const dialogPromise = new Promise((resolve) => { resolveDialog = resolve; });
    const registered = new Map<string, () => void>();
    const shortcutApi = {
      register: vi.fn((accelerator: string, handler: () => void) => {
        registered.set(accelerator, handler);
        return accelerator !== 'CommandOrControl+Shift+O';
      }),
    };
    const worker = { postMessage: vi.fn() };
    let paused = false;

    const startup = bootstrapOverlay({
      shortcutApi,
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: () => { paused = !paused; },
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: vi.fn().mockReturnValue(dialogPromise),
      createOverlayWindow: vi.fn(),
      startTerminalWorker: () => synchronizeWorkerPause(worker, paused),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    registered.get('CommandOrControl+Alt+Shift+P')?.();
    resolveDialog!({ response: 0 });
    await startup;

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'pause', paused: true });
  });

  it('skips display listeners when screenApi is null', async () => {
    const onMetrics = vi.fn();
    const onAdded = vi.fn();
    const onRemoved = vi.fn();

    await bootstrapOverlay({
      shortcutApi: createShortcutApi(true, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      createOverlayWindow: vi.fn(),
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: onMetrics,
      onDisplayAdded: onAdded,
      onDisplayRemoved: onRemoved,
      screenApi: null,
    });

    // Handlers must not be invoked since screenApi is null.
    expect(onMetrics).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('reports initialClickThrough false when passthrough shortcut fails', async () => {
    const result = await bootstrapOverlay({
      shortcutApi: createShortcutApi(false, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: vi.fn(),
      createOverlayWindow: vi.fn(),
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    expect(result.passthroughAvailable).toBe(false);
    expect(result.initialClickThrough).toBe(false);
    expect(result.dialogShown).toBe(true);
  });

  it('reports passthroughAvailable true when only non-passthrough fails', async () => {
    const result = await bootstrapOverlay({
      shortcutApi: createShortcutApi(true, false, false),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: vi.fn(),
      createOverlayWindow: vi.fn(),
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    expect(result.passthroughAvailable).toBe(true);
    expect(result.initialClickThrough).toBe(false);
    expect(result.dialogShown).toBe(true);
  });

  it('skips the dialog when showMessageBox is not provided', async () => {
    const result = await bootstrapOverlay({
      shortcutApi: createShortcutApi(false, false, false),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: undefined,
      createOverlayWindow: vi.fn(),
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    expect(result.dialogShown).toBe(false);
  });

  it('waits for dialog dismissal before creating the window', async () => {
    let resolveDialog: (value: unknown) => void;
    const dialogPromise = new Promise((resolve) => {
      resolveDialog = resolve;
    });
    const showBox = vi.fn().mockReturnValue(dialogPromise);
    const createWindow = vi.fn();

    bootstrapOverlay({
      shortcutApi: createShortcutApi(false, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: showBox,
      createOverlayWindow: createWindow,
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    // Before the dialog is resolved, the window must NOT be created.
    expect(createWindow).not.toHaveBeenCalled();
    expect(showBox).toHaveBeenCalledTimes(1);

    // Resolve the dialog (user dismisses the warning).
    resolveDialog!({ response: 0 });
    await dialogPromise;

    // Now the window should be created with click-through disabled.
    expect(createWindow).toHaveBeenCalledWith(false);
  });

  it('registers display event listeners when screenApi is provided', async () => {
    const onFn = vi.fn();
    const screenApi = { on: onFn };
    const onMetrics = vi.fn();
    const onAdded = vi.fn();
    const onRemoved = vi.fn();

    await bootstrapOverlay({
      shortcutApi: createShortcutApi(true, true, true),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      createOverlayWindow: vi.fn(),
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: onMetrics,
      onDisplayAdded: onAdded,
      onDisplayRemoved: onRemoved,
      screenApi,
    });

    expect(onFn).toHaveBeenCalledWith('display-metrics-changed', onMetrics);
    expect(onFn).toHaveBeenCalledWith('display-added', onAdded);
    expect(onFn).toHaveBeenCalledWith('display-removed', onRemoved);
  });
});

describe('startup — synchronizeWorkerPause', () => {
  it('sends a pause message to a live worker', () => {
    const worker = { postMessage: vi.fn() };

    const result = synchronizeWorkerPause(worker, true);

    expect(result).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'pause', paused: true });
  });

  it('returns false for a null worker', () => {
    expect(synchronizeWorkerPause(null, true)).toBe(false);
  });

  it('returns false for an undefined worker', () => {
    expect(synchronizeWorkerPause(undefined, false)).toBe(false);
  });

  it('coerces the paused value to a boolean', () => {
    const worker = { postMessage: vi.fn() };

    synchronizeWorkerPause(worker, 1 as any);

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'pause', paused: true });
  });
});

describe('startup — deriveInitialClickThrough', () => {
  it('returns true when all shortcuts registered (click-through ON)', () => {
    const result = deriveInitialClickThrough({
      allRegistered: true,
      failures: [],
    });
    expect(result).toBe(true);
  });

  it('returns false when any shortcut failed (click-through OFF for direct mouse)', () => {
    const result = deriveInitialClickThrough({
      allRegistered: false,
      failures: [{ name: 'togglePause' }],
    });
    expect(result).toBe(false);
  });
});

describe('startup — error resilience', () => {
  function createShortcutApi(...returnValues: boolean[]) {
    const callIterator = returnValues[Symbol.iterator]();
    return {
      register: vi.fn(() => {
        const next = callIterator.next();
        return next.value;
      }),
    };
  }

  it('activateOverlayWindow handles undefined window gracefully', () => {
    expect(activateOverlayWindow(undefined as any, false)).toBe(false);
    expect(activateOverlayWindow(undefined as any, true)).toBe(false);
  });

  it('bootstrapOverlay propagates errors from createOverlayWindow', async () => {
    await expect(
      bootstrapOverlay({
        shortcutApi: createShortcutApi(true, true, true),
        handlers: {
          togglePassthrough: vi.fn(),
          togglePause: vi.fn(),
          resetClimber: vi.fn(),
        },
        registerControls,
        createOverlayWindow: vi.fn(() => {
          throw new Error('window creation failed');
        }),
        startTerminalWorker: vi.fn(),
        onDisplayMetricsChanged: vi.fn(),
        onDisplayAdded: vi.fn(),
        onDisplayRemoved: vi.fn(),
        screenApi: null,
      })
    ).rejects.toThrow('window creation failed');
  });

  it('bootstrapOverlay propagates errors from startTerminalWorker', async () => {
    await expect(
      bootstrapOverlay({
        shortcutApi: createShortcutApi(true, true, true),
        handlers: {
          togglePassthrough: vi.fn(),
          togglePause: vi.fn(),
          resetClimber: vi.fn(),
        },
        registerControls,
        createOverlayWindow: vi.fn(),
        startTerminalWorker: vi.fn(() => {
          throw new Error('worker startup failed');
        }),
        onDisplayMetricsChanged: vi.fn(),
        onDisplayAdded: vi.fn(),
        onDisplayRemoved: vi.fn(),
        screenApi: null,
      })
    ).rejects.toThrow('worker startup failed');
  });

  it('bootstrapOverlay still registers display listeners when createOverlayWindow throws is false (worker errors out before listeners)', async () => {
    // Note: if startTerminalWorker throws, display listeners may or may not
    // have been registered depending on ordering. The implementation registers
    // them before starting the worker, so they persist even if the worker fails.
    const onFn = vi.fn();
    const screenApi = { on: onFn };
    const onMetrics = vi.fn();
    const onAdded = vi.fn();
    const onRemoved = vi.fn();

    await expect(
      bootstrapOverlay({
        shortcutApi: createShortcutApi(true, true, true),
        handlers: {
          togglePassthrough: vi.fn(),
          togglePause: vi.fn(),
          resetClimber: vi.fn(),
        },
        registerControls,
        createOverlayWindow: vi.fn(),
        startTerminalWorker: vi.fn(() => {
          throw new Error('worker startup failed');
        }),
        onDisplayMetricsChanged: onMetrics,
        onDisplayAdded: onAdded,
        onDisplayRemoved: onRemoved,
        screenApi,
      })
    ).rejects.toThrow('worker startup failed');

    // Display listeners are registered before startTerminalWorker in the
    // implementation, so they should have been attached despite the worker error.
    expect(onFn).toHaveBeenCalledWith('display-metrics-changed', onMetrics);
    expect(onFn).toHaveBeenCalledWith('display-added', onAdded);
    expect(onFn).toHaveBeenCalledWith('display-removed', onRemoved);
  });

  it('acquireSingleInstanceLock propagates errors from appApi.on', () => {
    const appApi = {
      requestSingleInstanceLock: vi.fn().mockReturnValue(true),
      quit: vi.fn(),
      on: vi.fn(() => {
        throw new Error('event listener registration failed');
      }),
    };

    expect(() => acquireSingleInstanceLock(appApi, vi.fn())).toThrow(
      'event listener registration failed'
    );
  });

  it('synchronizeWorkerPause handles worker with missing postMessage', () => {
    const worker = {} as any;

    expect(() => synchronizeWorkerPause(worker, true)).toThrow();
  });

  it('bootstrapOverlay skips dialog when showMessageBox is not a function', async () => {
    const result = await bootstrapOverlay({
      shortcutApi: createShortcutApi(false, false, false),
      handlers: {
        togglePassthrough: vi.fn(),
        togglePause: vi.fn(),
        resetClimber: vi.fn(),
      },
      registerControls,
      showMessageBox: 42 as any, // not a function
      createOverlayWindow: vi.fn(),
      startTerminalWorker: vi.fn(),
      onDisplayMetricsChanged: vi.fn(),
      onDisplayAdded: vi.fn(),
      onDisplayRemoved: vi.fn(),
      screenApi: null,
    });

    expect(result.dialogShown).toBe(false);
    expect(result.passthroughAvailable).toBe(false);
    expect(result.initialClickThrough).toBe(false);
  });

  it('buildConflictDialogOptions handles failures without accelerator property', () => {
    const failures = [{ name: 'togglePassthrough' }] as any;
    const opts = buildConflictDialogOptions(failures);
    // undefined accelerator becomes '' in Array.join(), so the list is empty.
    expect(opts.detail).toContain('Conflicting shortcuts:');
    expect(opts.buttons).toEqual(['OK']);
  });
});
