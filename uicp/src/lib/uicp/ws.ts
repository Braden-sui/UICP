import type { Batch, Envelope } from './schemas';
import { createFrameCoalescer, createId } from '../utils';

export type TransportEvents = {
  onHello?: (resumeToken?: string) => void;
  onBatch?: (batch: Batch) => void;
  onError?: (error: Error) => void;
  onDisconnect?: (reason: string) => void;
};

export type Transport = {
  connect: () => void;
  disconnect: () => void;
  send: (batch: Batch) => void;
  isConnected: () => boolean;
};

const parseJson = (input: unknown) => {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
};

// Websocket transport handles hello/resume semantics and coalesces outbound batches per animation frame.
export const createTransport = (
  url: string,
  dev: boolean,
  events: TransportEvents = {},
  resumeToken?: string,
): Transport => {
  let socket: WebSocket | null = null;
  let heartbeat: number | null = null;
  let lastHelloToken: string | undefined = resumeToken;
  const outboundCoalescer = createFrameCoalescer();
  const outboundQueue: Envelope[] = [];

  const sendHello = () => {
    if (!socket) return;
    const payload = {
      type: 'hello',
      protocol: 'uicp.core/1',
      dev,
      client_ts: new Date().toISOString(),
      resume_token: lastHelloToken,
    };
    socket.send(JSON.stringify(payload));
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeat = window.setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'ping',
          ts: Date.now(),
        }),
      );
    }, 15_000);
  };

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const flushOutbound = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!outboundQueue.length) return;
    const batch: Batch = outboundQueue.splice(0, outboundQueue.length);
    socket.send(
      JSON.stringify({
        type: 'batch',
        id: createId('batch'),
        batch,
      }),
    );
  };

  const connect = () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      socket = new WebSocket(url);
    } catch (error) {
      events.onError?.(error as Error);
      return;
    }

    socket.onopen = () => {
      sendHello();
      startHeartbeat();
    };

    socket.onclose = (event) => {
      stopHeartbeat();
      socket = null;
      events.onDisconnect?.(`close:${event.code}`);
    };

    socket.onerror = () => {
      events.onError?.(new Error('websocket-error'));
    };

    socket.onmessage = (event) => {
      const data = parseJson(event.data);
      if (!data || typeof data !== 'object') return;
      if ((data as { type?: string }).type === 'hello_ok') {
        lastHelloToken = (data as { resume_token?: string }).resume_token;
        events.onHello?.(lastHelloToken);
        return;
      }
      if ((data as { type?: string }).type === 'batch') {
        const payload = data as { batch: unknown };
        try {
          events.onBatch?.(payload.batch as Batch);
        } catch (error) {
          events.onError?.(error as Error);
        }
      }
    };
  };

  const disconnect = () => {
    stopHeartbeat();
    if (!socket) return;
    socket.close();
    socket = null;
  };

  const send = (batch: Batch) => {
    outboundQueue.push(...batch);
    outboundQueue.sort((a, b) => {
      const winA = a.windowId ?? '';
      const winB = b.windowId ?? '';
      if (winA === winB) return 0;
      return winA.localeCompare(winB);
    });
    outboundCoalescer.schedule(flushOutbound);
  };

  const isConnected = () => !!socket && socket.readyState === WebSocket.OPEN;

  return {
    connect,
    disconnect,
    send,
    isConnected,
  };
};

