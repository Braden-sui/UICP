export const getBridgeWindow = (): (Window & typeof globalThis) | undefined =>
  typeof window === 'undefined' ? undefined : window;

export const getComputeBridge = () => getBridgeWindow()?.uicpComputeCall;

export const getComputeCancelBridge = () => getBridgeWindow()?.uicpComputeCancel;
