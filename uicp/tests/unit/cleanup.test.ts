import { tryRecoverJsonFromAttribute } from '../../src/lib/uicp/cleanup';

describe('tryRecoverJsonFromAttribute', () => {
  it('repairs bare word values emitted by the planner', () => {
    const raw =
      '{"batch":[{"action":"state.set","payload":{"scope":"game","key":"status","value":playing"}}]}';
    const recovered = tryRecoverJsonFromAttribute(raw);
    expect(recovered).toBeTruthy();
    const parsed = JSON.parse(recovered!);
    expect(parsed.batch?.[0]?.payload?.value).toBe('playing');
  });

  it('preserves boolean literals when input is already strict JSON', () => {
    const raw = '{"batch":[{"payload":{"value":true}}]}';
    const recovered = tryRecoverJsonFromAttribute(raw);
    expect(recovered).toBeTruthy();
    const parsed = JSON.parse(recovered!);
    expect(parsed.batch?.[0]?.payload?.value).toBe(true);
  });
});
