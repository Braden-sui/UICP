import { describe, it, expect } from 'vitest';
import { parseUtterance } from '../../../src/lib/wil/parse';
import { toOp } from '../../../src/lib/wil/map';
import { validateBatch } from '../../../src/lib/uicp/schemas';

/**
 * Test coverage for window.create size parameter parsing.
 * 
 * CONTEXT: Agents were generating "size 1200x800" which parsed correctly but failed
 * Zod validation because size was kept as a string instead of being split into width/height.
 * 
 * FIXES:
 * 1. Added size splitting logic in map.ts for defense-in-depth
 * 2. Added "new" verb to window.create
 * 3. Added dimension clamping to prevent min(120) failures
 */

describe('window.create size parameter', () => {
  it('parses create window with size WxH format', () => {
    const utterance = 'create window title "Notes" size 1200x800';
    const parsed = parseUtterance(utterance);
    
    expect(parsed).toBeTruthy();
    expect(parsed?.op).toBe('window.create');
    
    const op = toOp(parsed!);
    expect(op.op).toBe('window.create');
    
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    expect(op.params.title).toBe('Notes');
    expect(op.params.width).toBe(1200);
    expect(op.params.height).toBe(800);
    // size should be removed to avoid schema clash
    expect(op.params.size).toBeUndefined();
  });

  it('validates size WxH through full batch pipeline', () => {
    const utterance = 'create window title "Notes" size 1200x800';
    const parsed = parseUtterance(utterance);
    const op = toOp(parsed!);
    
    // Should pass Zod validation
    const validated = validateBatch([op]);
    expect(validated).toHaveLength(1);
    
    const envelope = validated[0];
    expect(envelope.op).toBe('window.create');
    
    if (envelope.op !== 'window.create') throw new Error('Expected window.create');
    const params = envelope.params as { title: string; width: number; height: number };
    expect(params.width).toBe(1200);
    expect(params.height).toBe(800);
  });

  it('accepts "new" as a verb for window creation', () => {
    const utterance = 'new window title "Dashboard"';
    const parsed = parseUtterance(utterance);
    
    expect(parsed).toBeTruthy();
    expect(parsed?.op).toBe('window.create');
    
    const op = toOp(parsed!);
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    expect(op.params.title).toBe('Dashboard');
  });

  it('accepts "new window" with size WxH', () => {
    const utterance = 'new window title "Dashboard" size 800x600';
    const parsed = parseUtterance(utterance);
    
    expect(parsed).toBeTruthy();
    const op = toOp(parsed!);
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    expect(op.params.title).toBe('Dashboard');
    expect(op.params.width).toBe(800);
    expect(op.params.height).toBe(600);
  });

  it('handles size with whitespace variations', () => {
    const variations = [
      'create window title "Test" size 1200x800',
      'create window title "Test" size 1200 x 800',
      'create window title "Test" size 1200  x  800',
    ];

    for (const utterance of variations) {
      const parsed = parseUtterance(utterance);
      const op = toOp(parsed!);
      if (op.op !== 'window.create') throw new Error('Expected window.create');
      expect(op.params.width).toBe(1200);
      expect(op.params.height).toBe(800);
    }
  });

  it('clamps small dimensions to schema minimum of 120', () => {
    const utterance = 'create window title "Tiny" size 80x60';
    const parsed = parseUtterance(utterance);
    const op = toOp(parsed!);
    
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    // Dimensions should be clamped to min 120
    expect(op.params.width).toBe(120);
    expect(op.params.height).toBe(120);
    
    // Should pass validation
    const validated = validateBatch([op]);
    expect(validated).toHaveLength(1);
  });

  it('preserves preset size values (xs, sm, md, lg, xl)', () => {
    const utterance = 'create window title "Medium" size md';
    const parsed = parseUtterance(utterance);
    const op = toOp(parsed!);
    
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    // Preset values should pass through
    expect(op.params.size).toBe('md');
    expect(op.params.width).toBeUndefined();
    expect(op.params.height).toBeUndefined();
  });

  it('handles mixed explicit dimensions and position', () => {
    const utterance = 'create window title "Notes" width 1200 height 800';
    const parsed = parseUtterance(utterance);
    const op = toOp(parsed!);
    
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    expect(op.params.title).toBe('Notes');
    expect(op.params.width).toBe(1200);
    expect(op.params.height).toBe(800);
    
    const validated = validateBatch([op]);
    expect(validated).toHaveLength(1);
  });

  it('handles position with at x,y', () => {
    const utterance = 'create window title "Notes" at 100,200';
    const parsed = parseUtterance(utterance);
    const op = toOp(parsed!);
    
    if (op.op !== 'window.create') throw new Error('Expected window.create');
    expect(op.params.title).toBe('Notes');
    expect(op.params.x).toBe(100);
    expect(op.params.y).toBe(200);
  });

  it('rejects invalid size format at validation', () => {
    // Invalid format should not match the WxH pattern, will fail Zod validation
    const utterance = 'create window title "Bad" size invalid';
    const parsed = parseUtterance(utterance);
    
    // toOp should throw because 'invalid' is not a valid enum value or WxH format
    expect(() => toOp(parsed!)).toThrow();
  });
});
