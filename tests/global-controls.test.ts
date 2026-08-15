import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { ACCELERATORS, registerControls } = require('../electron/global-controls.cjs');

describe('global-controls', () => {
  it('defines the Escape accelerator for quitting', () => {
    expect(ACCELERATORS.quit).toBe('Escape');
  });

  it('attempts to register the accelerator when it succeeds', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(shortcutApi.register).toHaveBeenCalledTimes(1);
    expect(shortcutApi.register).toHaveBeenCalledWith(
      ACCELERATORS.quit,
      handlers.quit,
    );
    expect(result.allRegistered).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports false return values as failures', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(false),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.allRegistered).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('quit');
    expect(result.failures[0].error).toBeNull();
  });

  it('catches and reports exceptions during registration', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn(() => {
        throw new Error('native registration error');
      }),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.allRegistered).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('quit');
    expect(result.failures[0].error).toBe('native registration error');
  });

  it('invokes the correct handler for the accelerator', () => {
    const quitFn = vi.fn();

    const shortcutApi = {
      register: vi.fn((accelerator, handler) => {
        // Simulate a keypress by invoking the handler immediately.
        handler();
        return true;
      }),
    };

    registerControls(shortcutApi, {
      quit: quitFn,
    });

    expect(quitFn).toHaveBeenCalledTimes(1);
  });

  it('populates results array with success entries containing success and error fields', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.results).toHaveLength(1);
    for (const entry of result.results) {
      expect(entry.success).toBe(true);
      expect(entry.error).toBeNull();
      expect(entry.accelerator).toBeDefined();
    }
  });

  it('handles non-Error exceptions during registration', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn(() => {
        throw 'string error';
      }),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('quit');
    expect(result.failures[0].error).toBe('string error');
  });

  it('handles undefined/non-Error exceptions gracefully', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn(() => {
        throw undefined;
      }),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('quit');
    expect(result.failures[0].error).toBe('undefined');
  });

  it('ACCELERATORS object is frozen and cannot be modified', () => {
    expect(Object.isFrozen(ACCELERATORS)).toBe(true);
    expect(ACCELERATORS.quit).toBe('Escape');
  });

  it('failures array includes accelerator string for each failure', () => {
    const handlers = {
      quit: vi.fn(),
    };
    const shortcutApi = {
      register: vi.fn().mockReturnValue(false),
    };

    const result: { failures: Array<{ accelerator: string }> } =
      registerControls(shortcutApi, handlers);

    expect(result.failures.map((f) => f.accelerator)).toEqual([
      ACCELERATORS.quit,
    ]);
  });

  it('reports a missing callback without passing it to Electron', () => {
    const handlers = {} as Record<string, never>;
    const shortcutApi = {
      register: vi.fn().mockReturnValue(true),
    };

    const result = registerControls(shortcutApi, handlers);

    expect(shortcutApi.register).not.toHaveBeenCalled();
    expect(result.allRegistered).toBe(false);
    expect(result.failures).toEqual([{
      name: 'quit',
      accelerator: ACCELERATORS.quit,
      success: false,
      error: 'missing callback handler',
    }]);
  });
});
