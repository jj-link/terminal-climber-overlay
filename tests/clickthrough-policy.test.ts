import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  allowClickThroughChange,
  applyClickThroughToWindow,
} = require('../electron/clickthrough-policy.cjs');

describe('clickthrough-policy', () => {
  it('allows enabling click-through when passthrough shortcut is available', () => {
    expect(allowClickThroughChange(true, true)).toBe(true);
  });

  it('allows disabling click-through regardless of shortcut availability', () => {
    expect(allowClickThroughChange(false, true)).toBe(true);
    expect(allowClickThroughChange(false, false)).toBe(true);
  });

  it('rejects enabling click-through when passthrough shortcut is unavailable', () => {
    // This is the core safety invariant: if the keyboard recovery
    // shortcut failed to register, the IPC handler must refuse to
    // enable click-through (which would leave no way back).
    expect(allowClickThroughChange(true, false)).toBe(false);
  });

  it('synchronizes a newly created window even when canonical state is unchanged', () => {
    const window = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setIgnoreMouseEvents: vi.fn(),
      blur: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(applyClickThroughToWindow(window, false)).toBe(true);

    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true });
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it('applies click-through ON policy with blur and showInactive', () => {
    const window = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setIgnoreMouseEvents: vi.fn(),
      blur: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(applyClickThroughToWindow(window, true)).toBe(true);

    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(window.blur).toHaveBeenCalledTimes(1);
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it('returns false when window is null', () => {
    expect(applyClickThroughToWindow(null, true)).toBe(false);
    expect(applyClickThroughToWindow(null, false)).toBe(false);
  });

  it('returns false when window is destroyed', () => {
    const window = {
      isDestroyed: vi.fn().mockReturnValue(true),
      setIgnoreMouseEvents: vi.fn(),
      blur: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(applyClickThroughToWindow(window, true)).toBe(false);
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  });

  it('returns false when window is undefined', () => {
    expect(applyClickThroughToWindow(undefined as any, true)).toBe(false);
    expect(applyClickThroughToWindow(undefined as any, false)).toBe(false);
  });

  it('coerces the enabled value to a boolean', () => {
    const window = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setIgnoreMouseEvents: vi.fn(),
      blur: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    applyClickThroughToWindow(window, 1 as any);

    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  });

  it('does not focus when click-through is already enabled (idempotent)', () => {
    const window = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setIgnoreMouseEvents: vi.fn(),
      blur: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    // First call: enable click-through
    applyClickThroughToWindow(window, true);
    // Second call: same state, still applies
    applyClickThroughToWindow(window, true);

    expect(window.blur).toHaveBeenCalledTimes(2);
    expect(window.showInactive).toHaveBeenCalledTimes(2);
    expect(window.focus).not.toHaveBeenCalled();
  });

  it('allowClickThroughChange is stable for repeated identical calls', () => {
    // All four combinations should return consistent results.
    expect(allowClickThroughChange(true, true)).toBe(true);
    expect(allowClickThroughChange(true, true)).toBe(true);
    expect(allowClickThroughChange(true, false)).toBe(false);
    expect(allowClickThroughChange(true, false)).toBe(false);
    expect(allowClickThroughChange(false, true)).toBe(true);
    expect(allowClickThroughChange(false, true)).toBe(true);
    expect(allowClickThroughChange(false, false)).toBe(true);
    expect(allowClickThroughChange(false, false)).toBe(true);
  });
});
