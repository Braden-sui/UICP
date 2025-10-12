import { describe, it, expect } from 'vitest';
import { parseWILBatch } from '../../../src/lib/orchestrator/parseWILBatch';
import { validateBatch } from '../../../src/lib/uicp/schemas';

describe('WIL batch parsing (size variants)', () => {
  it('parses multiple WxH combinations', () => {
    const samples = [
      [200, 200],
      [320, 240],
      [520, 320],
      [800, 600],
      [1200, 800],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ];
    for (const [w, h] of samples) {
      const line = `create window title "S" size ${w}x${h}`;
      const items = parseWILBatch(line);
      const ops = items.filter((i): i is { op: string; params: any } => 'op' in i);
      const batch = validateBatch(ops);
      expect(batch.length).toBe(1);
      const env = batch[0];
      expect(env.op).toBe('window.create');
      expect((env.params as any).width).toBe(w);
      expect((env.params as any).height).toBe(h);
    }
  });
});

