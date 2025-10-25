import { describe, it, expect } from 'vitest';
import { createPermissionGate } from '../../src/lib/uicp/adapters/permissionGate';
import type { PermissionScope, PermissionContext } from '../../src/lib/uicp/adapters/adapter.types';

const gate = createPermissionGate();

const check = (scope: PermissionScope, ctx: PermissionContext) => gate.require(scope, ctx);

describe('PermissionGate default-deny with scoped rules', () => {
  it('denies dom.set when sanitize === false', async () => {
    const res = await check('dom', { operation: 'dom.set', params: { sanitize: false } });
    expect(res).toBe('denied');
  });

  it('grants dom.set when sanitize not specified (defaults to sanitized)', async () => {
    const res = await check('dom', { operation: 'dom.set', params: { html: '<b>ok</b>' } });
    expect(res).toBe('granted');
  });

  it('grants dom.append by default (sanitized path)', async () => {
    const res = await check('dom', { operation: 'dom.append', params: { target: '#root', html: '<div/>' } });
    expect(res).toBe('granted');
  });

  it('grants window operations', async () => {
    const res = await check('window', { operation: 'window.create', params: { id: 'w1', title: 'T' } });
    expect(res).toBe('granted');
  });

  it('grants component operations', async () => {
    const res = await check('components', { operation: 'component.update', params: { id: 'c1', props: {} } });
    expect(res).toBe('granted');
  });

  it('grants benign state operations under dom scope', async () => {
    const res1 = await check('dom', { operation: 'state.set', params: { scope: 'workspace', key: 'k', value: 1 } });
    const res2 = await check('dom', { operation: 'state.get', params: { scope: 'workspace', key: 'k' } });
    const res3 = await check('dom', { operation: 'state.patch', params: { scope: 'workspace', key: 'k', ops: [] } });
    const res4 = await check('dom', { operation: 'txn.cancel', params: {} });
    expect(res1).toBe('granted');
    expect(res2).toBe('granted');
    expect(res3).toBe('granted');
    expect(res4).toBe('granted');
  });

  it('grants api.call here (actual gating handled in adapter.api)', async () => {
    const res = await check('dom', { operation: 'api.call', params: { url: 'https://example.com' } });
    expect(res).toBe('granted');
  });

  it('default-denies unknown ops under dom scope', async () => {
    const res = await check('dom', { operation: 'dom.unknown', params: {} });
    expect(res).toBe('denied');
  });

  it('isGated returns true only for dom scope', () => {
    expect(gate.isGated('dom')).toBe(true);
    expect(gate.isGated('window')).toBe(false);
    expect(gate.isGated('components')).toBe(false);
  });
});
