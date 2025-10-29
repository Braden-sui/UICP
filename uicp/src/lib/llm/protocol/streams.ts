export type StreamContentEvent = { type: 'content'; channel?: string; text: string };
export type StreamToolCallEvent = {
  type: 'tool_call';
  index: number;
  id?: string;
  name?: string;
  arguments: unknown;
  isDelta: boolean;
};
export type StreamReturnEvent = { type: 'return'; channel?: string; name?: string; result: unknown };
export type StreamDoneEvent = { type: 'done' };
export type StreamErrorEvent = { type: 'error'; code: string; detail?: string };

export type StreamEventV1 =
  | StreamContentEvent
  | StreamToolCallEvent
  | StreamReturnEvent
  | StreamDoneEvent
  | StreamErrorEvent;
