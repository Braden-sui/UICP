/**
 * Batch Linter Tests
 * 
 * Validates pre-apply gate rules that enforce component-first behavior
 */

import { describe, it, expect } from 'vitest';
import { lintBatch, formatLintError } from '../../src/lib/uicp/adapters/batchLinter';
import type { Batch } from '../../src/lib/uicp/adapters/schemas';

describe('batchLinter', () => {
  describe('Rule 0: Special cases always pass', () => {
    it('allows empty batches', () => {
      const batch: Batch = [];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows txn.cancel batches', () => {
      const batch: Batch = [
        { op: 'txn.cancel', params: {} },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });
  });

  describe('Rule 1: Batch must create visible effect (E-UICP-0401)', () => {
    it('rejects batch with only state.set', () => {
      const batch: Batch = [
        { op: 'state.set', params: { scope: 'window', key: 'x', value: 42 } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('E-UICP-0401');
        expect(result.reason).toContain('no visible UI effect');
      }
    });

    it('rejects batch with only api.call without UI follow-up', () => {
      const batch: Batch = [
        { op: 'api.call', params: { url: 'https://example.com', method: 'GET' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('E-UICP-0401');
      }
    });

    it('allows batch with window.create', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows batch with dom.set', () => {
      const batch: Batch = [
        { op: 'dom.set', params: { windowId: 'win-1', target: '#root', html: '<div>Test</div>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows batch with component.render', () => {
      const batch: Batch = [
        { op: 'component.render', params: { windowId: 'win-1', target: '#root', type: 'button.v1', props: { label: 'Click' } } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });
  });

  describe('Rule 2: No dangling selectors (E-UICP-0402)', () => {
    it('rejects dom.set without windowId or window.create', () => {
      const batch: Batch = [
        { op: 'dom.set', params: { windowId: '', target: '#root', html: '<div>Test</div>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('E-UICP-0402');
        expect(result.reason).toContain('without creating or specifying window');
      }
    });

    it('allows dom.set with windowId', () => {
      const batch: Batch = [
        { op: 'dom.set', params: { windowId: 'win-1', target: '#root', html: '<div>Test</div>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows dom.set after window.create', () => {
      const batch: Batch = [
        { op: 'window.create', params: { id: 'win-1', title: 'Test' } },
        { op: 'dom.set', params: { windowId: 'win-1', target: '#root', html: '<div>Test</div>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });
  });

  describe('Rule 3: No inert text-only appends (E-UICP-0403)', () => {
    it('rejects batch with only plain text dom.append', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'dom.append', params: { windowId: 'win-1', target: '#root', html: 'Just some text' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('E-UICP-0403');
        expect(result.reason).toContain('only appends plain text');
      }
    });

    it('allows dom.append with interactive elements (button)', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'dom.append', params: { windowId: 'win-1', target: '#root', html: '<button>Click</button>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows dom.append with data-command attribute', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'dom.append', params: { windowId: 'win-1', target: '#root', html: '<div data-command="[]">Action</div>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows dom.append with input field', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'dom.append', params: { windowId: 'win-1', target: '#root', html: '<input type="text" />' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows dom.append with link', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'dom.append', params: { windowId: 'win-1', target: '#root', html: '<a href="https://example.com">Link</a>' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows batch with component.render', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'component.render', params: { windowId: 'win-1', target: '#root', type: 'data.table', props: { columns: ['a'], rows: [] } } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows dom.set (not just append)', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Test' } },
        { op: 'dom.set', params: { windowId: 'win-1', target: '#root', html: 'Plain text is ok in dom.set' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });
  });

  describe('formatLintError', () => {
    it('returns empty string for ok result', () => {
      const result = { ok: true as const };
      const formatted = formatLintError(result);
      expect(formatted).toBe('');
    });

    it('formats error with code, reason, and hint', () => {
      const result = {
        ok: false as const,
        code: 'E-UICP-0401',
        reason: 'Test reason',
        hint: 'Test hint',
      };
      const formatted = formatLintError(result);
      expect(formatted).toContain('BATCH REJECTED');
      expect(formatted).toContain('E-UICP-0401');
      expect(formatted).toContain('Test reason');
      expect(formatted).toContain('Test hint');
    });
  });

  describe('Integration: realistic batches', () => {
    it('allows complete table rendering batch', () => {
      const batch: Batch = [
        { op: 'window.create', params: { id: 'win-data', title: 'Data View', size: 'lg' } },
        { op: 'component.render', params: {
          windowId: 'win-data',
          target: '#root',
          type: 'data.table',
          props: {
            columns: ['name', 'age'],
            rows: [{ name: 'Alice', age: 30 }],
          },
        }},
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('allows form with api.call', () => {
      const batch: Batch = [
        { op: 'window.create', params: { id: 'win-form', title: 'Form' } },
        { op: 'component.render', params: {
          windowId: 'win-form',
          target: '#root',
          type: 'form.v1',
          props: {
            fields: [{ name: 'email', label: 'Email', type: 'email' }],
          },
        }},
        { op: 'api.call', params: { url: 'https://api.example.com/submit', method: 'POST' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(true);
    });

    it('rejects "box with text only" anti-pattern', () => {
      const batch: Batch = [
        { op: 'window.create', params: { title: 'Result' } },
        { op: 'dom.append', params: { windowId: 'win-1', target: '#root', html: 'Here is your answer' } },
      ];
      const result = lintBatch(batch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('E-UICP-0403');
      }
    });
  });
});
