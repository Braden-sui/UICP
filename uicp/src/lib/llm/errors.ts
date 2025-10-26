import { UICPError } from '../bridge/result';

export const LLMErrorCode = {
  CodeRouteGuard: 'E-UICP-0911',
  PlannerModelMissing: 'E-UICP-1200',
  ActorModelMissing: 'E-UICP-1201',
  PlannerEmpty: 'E-UICP-1202',
  PlannerMissingToolCall: 'E-UICP-1203',
  PlannerFailure: 'E-UICP-1204',
  ActorEmpty: 'E-UICP-1210',
  ActorMissingToolCall: 'E-UICP-1211',
  ActorInvalidBatch: 'E-UICP-1212',
  ActorFailure: 'E-UICP-1213',
  StreamBridgeUnavailable: 'E-UICP-1220',
  StreamUpstreamError: 'E-UICP-1221',
  StreamTimeout: 'E-UICP-1222',
  StreamListenerTeardown: 'E-UICP-1223',
  ToolCollectionTimeout: 'E-UICP-0100',
  ToolArgsParseFailed: 'E-UICP-0101',
  ToolCollectionFailed: 'E-UICP-0102',
  ToolCollectionAllTimeout: 'E-UICP-0103',
  ToolCollectionAllFailed: 'E-UICP-0104',
  CollectionTimeout: 'E-UICP-0105',
  CollectionFailed: 'E-UICP-0106',
  PlanNormalizationFailed: 'E-UICP-0420',
  BatchNormalizationFailed: 'E-UICP-0421',
  TaskSpecEmpty: 'E-UICP-1240',
  TaskSpecParseFailed: 'E-UICP-1241',
  TaskSpecGeneralFailure: 'E-UICP-1242',
  Unknown: 'E-UICP-1299',
} as const;

export type LLMErrorCodeT = (typeof LLMErrorCode)[keyof typeof LLMErrorCode];

const llmCodeValues = new Set<string>(Object.values(LLMErrorCode));

export class LLMError extends UICPError {
  constructor(code: LLMErrorCodeT, message: string, detail?: string, cause?: unknown) {
    super(code, message, detail, cause);
    this.name = 'LLMError';
  }
}

export const toLLMError = (error: unknown, fallback: LLMErrorCodeT = LLMErrorCode.Unknown): LLMError => {
  if (error instanceof LLMError) {
    return error;
  }

  if (error instanceof UICPError) {
    const code = llmCodeValues.has(error.code) ? (error.code as LLMErrorCodeT) : fallback;
    return new LLMError(code, error.message, error.detail, error);
  }

  if (error instanceof Error) {
    return new LLMError(fallback, error.message, undefined, error);
  }

  return new LLMError(fallback, String(error));
};
