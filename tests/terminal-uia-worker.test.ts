import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface TextRunGeometry {
  start: number;
  length: number;
  rect: { x: number; y: number; width: number; height: number };
}

const require = createRequire(import.meta.url);
const { textRunGeometry } = require('../electron/terminal-uia-worker.cjs') as {
  textRunGeometry: (
    text: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => TextRunGeometry[];
};

describe('terminal UIA text segment geometry', () => {
  it('leaves whitespace gaps between privacy-safe text runs', () => {
    const runs = textRunGeometry('alpha  beta gamma', {
      x: 100,
      y: 200,
      width: 170,
      height: 19,
    });

    expect(runs).toEqual([
      {
        start: 0,
        length: 5,
        rect: { x: 100, y: 200, width: 50, height: 19 },
      },
      {
        start: 7,
        length: 4,
        rect: { x: 170, y: 200, width: 40, height: 19 },
      },
      {
        start: 12,
        length: 5,
        rect: { x: 220, y: 200, width: 50, height: 19 },
      },
    ]);
    expect(Object.keys(runs[0])).toEqual(['start', 'length', 'rect']);
  });
});
