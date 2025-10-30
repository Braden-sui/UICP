import { streamOllamaCompletion, type ChatMessage, type ToolSpec, type StreamEvent } from './llm.stream';
import { isProviderRouterV1Enabled, isProviderRouterCanaryEnabled } from '../flags';
import { emitTelemetryEvent } from '../telemetry';

// NOTE: Router delegates to provider-specific backends when flags are enabled.
// When VITE_PROVIDER_ROUTER_V1 is enabled, uses the new generic chat_completion endpoint.
// Canary mode allows gradual rollout for specific providers.

export type RouterRequestOptions = Parameters<typeof streamOllamaCompletion>[3] & {
  provider?: string;
};

export const route = (
  messages: ChatMessage[],
  model: string,
  tools?: ToolSpec[],
  options?: RouterRequestOptions,
): AsyncIterable<StreamEvent> => {
  const isRouterEnabled = isProviderRouterV1Enabled() || isProviderRouterCanaryEnabled();
  const provider = options?.provider;
  
  // Emit router provider selection telemetry
  if (provider) {
    emitTelemetryEvent('router_provider_selected', {
      traceId: 'router-selection', // Use a fixed traceId for router decisions
      span: 'api',
      data: { 
        provider, 
        model, 
        routerEnabled: isRouterEnabled,
        canaryMode: isProviderRouterCanaryEnabled(),
        hasTools: tools && tools.length > 0
      }
    });
  }
  
  if (isRouterEnabled && provider) {
    // Use the new provider-aware backend routing
    return streamOllamaCompletion(messages, model, tools, {
      ...options,
      // Pass provider explicitly to enable backend routing
      provider: provider,
    });
  }
  
  // Legacy path: direct delegation to current streaming path
  return streamOllamaCompletion(messages, model, tools, options);
};
