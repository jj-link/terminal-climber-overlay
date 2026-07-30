import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { ACCELERATORS, registerControls } = require('../electron/global-controls.cjs');

describe('global-controls', () => {
  it('defines expected accelerators', () => {
    expect(ACCELERATORS.togglePassthrough).toBe('CommandOrControl+Shift+O');
    expect(ACCELERATORS.togglePause).toBe('CommandOrControl+Alt+Shift+P');
    expect(ACCELERATORS.resetClimber).toBe('CommandOrControl+Alt+Shift+R');
  });

  it('attempts to register all accelerators when all succeed', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(shortcutApi.register).toHaveBeenCalledTimes(3);
    expect(shortcutApi.register).toHaveBeenCalledWith(
      ACCELERATORS.togglePassthrough,
      handlers.togglePassthrough,
    );
    expect(shortcutApi.register).toHaveBeenCalledWith(
      ACCELERATORS.togglePause,
      handlers.togglePause,
    );
    expect(shortcutApi.register).toHaveBeenCalledWith(
      ACCELERATORS.resetClimber,
      handlers.resetClimber,
    );
    expect(result.allRegistered).toBe(true);
    expect(result.passthroughAvailable).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports false return values as failures', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(false),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.allRegistered).toBe(false);
    expect(result.passthroughAvailable).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0].name).toBe('togglePassthrough');
    expect(result.failures[0].error).toBeNull();
  });

  it('catches and reports exceptions during registration', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn()
        .mockReturnValueOnce(true)
        .mockImplementationOnce(() => {
          throw new Error('native registration error');
        })
        .mockReturnValueOnce(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.allRegistered).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('togglePause');
    expect(result.failures[0].error).toBe('native registration error');
  });

  it('marks passthroughAvailable false only when passthrough fails', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn()
        .mockReturnValueOnce(false) // passthrough fails
        .mockReturnValueOnce(true) // pause ok
        .mockReturnValueOnce(true), // reset ok
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.passthroughAvailable).toBe(false);
    expect(result.allRegistered).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('togglePassthrough');
  });

  it('invokes the correct handler for each accelerator', () => {
    const togglePassthroughFn = vi.fn();
    const togglePauseFn = vi.fn();
    const resetClimberFn = vi.fn();

    const shortcutApi = {
      register: vi.fn((accelerator, handler) => {
        // Simulate a keypress by invoking the handler immediately.
        handler();
        return true;
      }),
    };

    registerControls(shortcutApi, {
      togglePassthrough: togglePassthroughFn,
      togglePause: togglePauseFn,
      resetClimber: resetClimberFn,
    });

    expect(togglePassthroughFn).toHaveBeenCalledTimes(1);
    expect(togglePauseFn).toHaveBeenCalledTimes(1);
    expect(resetClimberFn).toHaveBeenCalledTimes(1);
  });

  it('keeps passthroughAvailable true when only non-passthrough shortcuts fail', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn()
        .mockReturnValueOnce(true)  // passthrough ok
        .mockReturnValueOnce(false) // pause fails
        .mockReturnValueOnce(false), // reset fails
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.passthroughAvailable).toBe(true);
    expect(result.allRegistered).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].name).toBe('togglePause');
    expect(result.failures[1].name).toBe('resetClimber');
  });

  it('populates results array with success entries containing success and error fields', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.results).toHaveLength(3);
    for (const entry of result.results) {
      expect(entry.success).toBe(true);
      expect(entry.error).toBeNull();
      expect(entry.accelerator).toBeDefined();
    }
  });

  it('handles non-Error exceptions during registration', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn()
        .mockReturnValueOnce(true)
        .mockImplementationOnce(() => {
          throw 'string error';
        })
        .mockReturnValueOnce(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('togglePause');
    expect(result.failures[0].error).toBe('string error');
  });

  it('handles undefined/non-Error exceptions gracefully', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn()
        .mockReturnValueOnce(true)
        .mockImplementationOnce(() => {
          throw undefined;
        })
        .mockReturnValueOnce(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('togglePause');
    expect(result.failures[0].error).toBe('undefined');
  });

  it('marks passthroughAvailable false when passthrough throws an exception', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn()
        .mockImplementationOnce(() => {
          throw new Error('native conflict');
        })
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.passthroughAvailable).toBe(false);
    expect(result.allRegistered).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('togglePassthrough');
    expect(result.failures[0].error).toBe('native conflict');
  });

  it('ACCELERATORS object is frozen and cannot be modified', () => {
    expect(() => {
      ACCELERATORS.togglePassthrough = 'Ctrl+O';
    }).toThrow();

    // Verify original value is unchanged
    expect(ACCELERATORS.togglePassthrough).toBe('CommandOrControl+Shift+O');
  });

  it('failures array includes accelerator string for each failure', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(false),
    };

    const result: { failures: Array<{ accelerator: string }> } = registerControls(shortcutApi, handlers);

    expect(result.failures.map((f) => f.accelerator)).toEqual([
      ACCELERATORS.togglePassthrough,
      ACCELERATORS.togglePause,
      ACCELERATORS.resetClimber,
    ]);
  });

  it('registers controls in deterministic key order', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      togglePause: vi.fn(),
      resetClimber: vi.fn(),
    };
    const callOrder: string[] = [];
    const shortcutApi = {
      register: vi.fn((accelerator: string, handler: () => void) => {
        callOrder.push(accelerator);
        return true;
      }),
    };

    registerControls(shortcutApi, handlers);

    expect(callOrder).toEqual([
      ACCELERATORS.togglePassthrough,
      ACCELERATORS.togglePause,
      ACCELERATORS.resetClimber,
    ]);
  });

  it('reports a missing callback without passing it to Electron', () => {
    const handlers = {
      togglePassthrough: vi.fn(),
      // togglePause is missing
      resetClimber: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, handlers as any);

    expect(shortcutApi.register).toHaveBeenCalledTimes(2);
    expect(result.allRegistered).toBe(false);
    expect(result.failures).toEqual([{
      name: 'togglePause',
      accelerator: ACCELERATORS.togglePause,
      success: false,
      error: 'missing callback handler',
    }]);
  });

  it('fails every control safely when all callbacks are missing', () => {
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, {} as any);

    expect(shortcutApi.register).not.toHaveBeenCalled();
    expect(result.allRegistered).toBe(false);
    expect(result.passthroughAvailable).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.every((entry: { error: string | null }) => entry.error === 'missing callback handler')).toBe(true);
  });
});
