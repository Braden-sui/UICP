import { readBooleanEnv } from './env/values';

export const isChatProtocolV1Enabled = (): boolean => readBooleanEnv('VITE_CHAT_PROTOCOL_V1', false);
export const isStreamV1Enabled = (): boolean => readBooleanEnv('VITE_STREAM_V1', false);
export const isProblemDetailV1Enabled = (): boolean => readBooleanEnv('VITE_PROBLEM_DETAIL_V1', false);
export const isApplyHandshakeV1Enabled = (): boolean => readBooleanEnv('VITE_APPLY_HANDSHAKE_V1', false);
export const isProviderRouterV1Enabled = (): boolean => readBooleanEnv('VITE_PROVIDER_ROUTER_V1', false);
export const isProviderRouterCanaryEnabled = (): boolean => readBooleanEnv('VITE_PROVIDER_ROUTER_CANARY', false);

export const getActiveFlags = (): Record<string, boolean> => ({
  chatProtocolV1: isChatProtocolV1Enabled(),
  streamV1: isStreamV1Enabled(),
  problemDetailV1: isProblemDetailV1Enabled(),
  applyHandshakeV1: isApplyHandshakeV1Enabled(),
  providerRouterV1: isProviderRouterV1Enabled(),
  providerRouterCanary: isProviderRouterCanaryEnabled(),
});

export const flagsSummary = (): string => {
  const flags = getActiveFlags();
  const parts: string[] = [];
  for (const [k, v] of Object.entries(flags)) {
    parts.push(`${k}=${v ? 'on' : 'off'}`);
  }
  return parts.join(', ');
};
