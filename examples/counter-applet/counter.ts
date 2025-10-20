/**
 * Counter Applet - Example TypeScript applet for UICP
 * 
 * This demonstrates the script.panel interface pattern:
 * - init(): Returns initial state
 * - render(state): Returns HTML for the current state
 * - onEvent(action, payload, state): Handles events and returns next state
 * 
 * To build:
 *   node uicp/scripts/build-applet.mjs examples/counter-applet/counter.ts --out examples/counter-applet/counter.js
 * 
 * To use in script.panel:
 *   { "type": "script.panel", "props": { "id": "counter", "source": "<bundled-js>" } }
 */

interface AppletState {
  count: number;
}

interface OnEventResult {
  next_state?: string;
  batch?: unknown;
}

const applet = {
  /**
   * Initialize the applet and return the initial state.
   * Called once when the panel is first created.
   */
  init(): string {
    const initialState: AppletState = { count: 0 };
    return JSON.stringify(initialState);
  },

  /**
   * Render the UI for the given state.
   * Returns HTML string (will be sanitized by the host).
   */
  render(state: string): string {
    const model: AppletState = JSON.parse(state || '{}');
    const count = model.count || 0;

    return `
      <div class="counter-applet">
        <style>
          .counter-applet {
            padding: 20px;
            font-family: system-ui, -apple-system, sans-serif;
          }
          .counter-display {
            font-size: 48px;
            font-weight: bold;
            text-align: center;
            margin: 20px 0;
            color: #333;
          }
          .counter-controls {
            display: flex;
            gap: 10px;
            justify-content: center;
          }
          .counter-btn {
            padding: 10px 20px;
            font-size: 18px;
            border: 2px solid #007bff;
            background: white;
            color: #007bff;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
          }
          .counter-btn:hover {
            background: #007bff;
            color: white;
          }
        </style>
        <h2>Counter Applet</h2>
        <div class="counter-display">${count}</div>
        <div class="counter-controls">
          <button 
            class="counter-btn" 
            data-command='{"type":"script.emit","action":"decrement","payload":{}}'>
            − Decrement
          </button>
          <button 
            class="counter-btn" 
            data-command='{"type":"script.emit","action":"reset","payload":{}}'>
            Reset
          </button>
          <button 
            class="counter-btn" 
            data-command='{"type":"script.emit","action":"increment","payload":{}}'>
            + Increment
          </button>
        </div>
      </div>
    `;
  },

  /**
   * Handle UI events from buttons/interactions.
   * Returns a result with optional next_state and batch commands.
   */
  onEvent(action: string, payload: string, state: string): string {
    const model: AppletState = JSON.parse(state || '{}');
    let count = model.count || 0;

    switch (action) {
      case 'increment':
        count += 1;
        break;
      case 'decrement':
        count -= 1;
        break;
      case 'reset':
        count = 0;
        break;
      default:
        // Unknown action - return current state unchanged
        return JSON.stringify({ next_state: state });
    }

    const nextState: AppletState = { count };
    const result: OnEventResult = {
      next_state: JSON.stringify(nextState),
    };

    return JSON.stringify(result);
  },
};

export default applet;
