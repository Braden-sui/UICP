/**
 * WindowManager Module
 * 
 * Handles all window lifecycle operations: create, move, resize, focus, close.
 * Enforces coordinate clamping and idempotent operations.
 * 
 * PR 2: Extracted from adapter.lifecycle.ts monolith
 */

import { createId } from '../../utils';
import { escapeForSelector, applyDynamicStyleRule, removeDynamicStyleRule, type DynamicStyleDeclarations } from '../../css/dynamicStyles';
import type { WindowId, WindowRecord, WindowLifecycleEvent, WindowLifecycleListener } from './adapter.types';
import type { OperationParamMap } from '../../schema';
import { AdapterError } from './adapter.errors';

export interface WindowManager {
  create(params: OperationParamMap['window.create']): Promise<{ windowId: string; applied: boolean }>;
  move(params: OperationParamMap['window.move']): Promise<{ applied: boolean }>;
  resize(params: OperationParamMap['window.resize']): Promise<{ applied: boolean }>;
  focus(params: OperationParamMap['window.focus']): Promise<{ applied: boolean }>;
  close(params: OperationParamMap['window.close']): Promise<{ applied: boolean }>;
  exists(id: WindowId): boolean;
  list(): Array<{ id: string; title: string }>;
  getRecord(id: WindowId): WindowRecord | undefined;
}

/**
 * Create a WindowManager instance bound to a workspace root element.
 */
export const createWindowManager = (
  root: HTMLElement,
  options?: {
    onLifecycleEvent?: (event: WindowLifecycleEvent) => void;
  }
): WindowManager => {
  const windows = new Map<WindowId, WindowRecord>();
  const windowDragCleanup = new Map<HTMLElement, () => void>();
  const lifecycleListeners = new Set<WindowLifecycleListener>();

  if (options?.onLifecycleEvent) {
    lifecycleListeners.add(options.onLifecycleEvent);
  }

  const emitWindowEvent = (event: WindowLifecycleEvent) => {
    for (const listener of lifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`Window lifecycle listener failed for ${event.type}:`, error);
      }
    }
  };

  /**
   * Clamp value to range, handling NaN and infinity
   */
  const clampRange = (value: number, min: number, max: number): number => {
    if (Number.isNaN(value)) return min;
    if (!Number.isFinite(max) || max <= min) return min;
    return Math.min(Math.max(min, value), max);
  };

  /**
   * Get desktop bounds for clamping coordinates
   */
  const getDesktopBounds = () => {
    const width = root.clientWidth || 1920;
    const height = root.clientHeight || 1080;
    return { width, height };
  };

  /**
   * Apply geometry updates to window via dynamic CSS
   */
  const applyWindowGeometry = (
    record: WindowRecord,
    params: Partial<{ x: number; y: number; width: number; height: number; zIndex: number }>
  ) => {
    const declarations: DynamicStyleDeclarations = {};
    const bounds = getDesktopBounds();
    
    // Clamp coordinates to desktop bounds
    if (typeof params.x === 'number') {
      const clamped = clampRange(params.x, 0, Math.max(0, bounds.width - 200));
      declarations.left = `${clamped}px`;
    }
    if (typeof params.y === 'number') {
      const clamped = clampRange(params.y, 0, Math.max(0, bounds.height - 100));
      declarations.top = `${clamped}px`;
    }
    if (typeof params.width === 'number') {
      const clamped = clampRange(params.width, 200, 4000);
      declarations.width = `${clamped}px`;
    }
    if (typeof params.height === 'number') {
      const clamped = clampRange(params.height, 150, 3000);
      declarations.height = `${clamped}px`;
    }
    if (typeof params.zIndex === 'number') {
      declarations['z-index'] = String(params.zIndex);
    }

    if (Object.keys(declarations).length === 0) return;
    applyDynamicStyleRule(record.styleSelector, declarations);
  };

  /**
   * Destroy window and clean up resources
   */
  const destroyWindow = (id: WindowId): void => {
    const record = windows.get(id);
    if (!record) return;

    // Clean up drag listeners
    const dragCleanup = windowDragCleanup.get(record.wrapper);
    if (dragCleanup) {
      try {
        dragCleanup();
      } catch (error) {
        console.error(`Failed to cleanup drag listeners for window ${id}:`, error);
      }
      windowDragCleanup.delete(record.wrapper);
    }

    // Remove dynamic styles
    removeDynamicStyleRule(record.styleSelector);

    // Remove from DOM
    record.wrapper.remove();
    windows.delete(id);

    emitWindowEvent({
      type: 'destroyed',
      id,
      title: record.titleText.textContent ?? id,
    });
  };

  /**
   * Create or update a window
   */
  const create = async (params: OperationParamMap['window.create']): Promise<{ windowId: string; applied: boolean }> => {
    const id = params.id ?? createId('window');
    const existing = windows.get(id);

    // If window exists, update it (idempotent)
    if (existing) {
      applyWindowGeometry(existing, {
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        zIndex: params.zIndex,
      });
      existing.titleText.textContent = params.title;
      emitWindowEvent({ type: 'updated', id, title: params.title });
      return { windowId: id, applied: false }; // Idempotent no-op
    }

    // Create new window
    const wrapper = document.createElement('div');
    wrapper.dataset.windowId = id;
    const styleSelector = `[data-window-id="${escapeForSelector(id)}"]`;
    wrapper.className = 'workspace-window pointer-events-auto';

    // Chrome (title bar)
    const chrome = document.createElement('div');
    chrome.className =
      'window-title flex items-center justify-between bg-gradient-to-r from-white/80 to-white/70 px-4 py-3 text-sm font-semibold text-slate-700 backdrop-blur-sm select-none cursor-grab border-b border-slate-200/40';

    const titleText = document.createElement('span');
    titleText.className = 'truncate';
    titleText.textContent = params.title;
    chrome.appendChild(titleText);

    const controls = document.createElement('div');
    controls.className = 'ml-3 flex items-center gap-2';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close window');
    closeButton.textContent = '×';
    closeButton.className =
      'flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-base text-slate-500 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 hover:scale-110 active:scale-95';

    // Prevent drag when clicking close button
    const stopPointerPropagation = (event: Event) => event.stopPropagation();
    closeButton.addEventListener('pointerdown', stopPointerPropagation);
    closeButton.addEventListener('pointerup', stopPointerPropagation);
    closeButton.addEventListener('mousedown', stopPointerPropagation);
    closeButton.addEventListener('mouseup', stopPointerPropagation);
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      destroyWindow(id);
    });

    controls.appendChild(closeButton);
    chrome.appendChild(controls);

    // Content area
    const content = document.createElement('div');
    content.className =
      'window-content flex-1 overflow-auto bg-gradient-to-b from-white/50 to-white/30 px-4 py-3 backdrop-blur-sm';
    const rootNode = document.createElement('div');
    rootNode.id = 'root';
    content.appendChild(rootNode);

    wrapper.appendChild(chrome);
    wrapper.appendChild(content);

    // Set min dimensions
    const initialWidth = typeof params.width === 'number' ? params.width : 640;
    const initialHeight = typeof params.height === 'number' ? params.height : 480;
    const MIN_WIDTH = Math.max(240, Math.floor(initialWidth * 0.6));
    const MIN_HEIGHT = Math.max(220, Math.floor(initialHeight * 0.6));

    wrapper.style.minWidth = `${MIN_WIDTH}px`;
    wrapper.style.minHeight = `${MIN_HEIGHT}px`;

    // Create window record
    const record: WindowRecord = {
      id,
      wrapper,
      content,
      titleText,
      styleSelector,
    };

    // Add to DOM
    root.appendChild(wrapper);
    windows.set(id, record);

    // Apply initial geometry (clamped to bounds)
    const initialGeometry: Partial<{ x: number; y: number; width: number; height: number; zIndex: number }> = {
      width: initialWidth,
      height: initialHeight,
    };

    if (typeof params.x === 'number') initialGeometry.x = params.x;
    if (typeof params.y === 'number') initialGeometry.y = params.y;
    if (typeof params.zIndex === 'number') initialGeometry.zIndex = params.zIndex;

    applyWindowGeometry(record, initialGeometry);

    emitWindowEvent({ type: 'created', id, title: params.title });

    return { windowId: id, applied: true };
  };

  /**
   * Move window to new position (idempotent)
   */
  const move = async (params: OperationParamMap['window.move']): Promise<{ applied: boolean }> => {
    const record = windows.get(params.id);
    if (!record) {
      throw new AdapterError('Adapter.WindowNotFound', `Window not found: ${params.id}`);
    }

    applyWindowGeometry(record, {
      x: params.x,
      y: params.y,
    });
    return { applied: true };
  };

  /**
   * Resize window (idempotent)
   */
  const resize = async (params: OperationParamMap['window.resize']): Promise<{ applied: boolean }> => {
    const record = windows.get(params.id);
    if (!record) {
      throw new AdapterError('Adapter.WindowNotFound', `Window not found: ${params.id}`);
    }

    applyWindowGeometry(record, {
      width: params.width,
      height: params.height,
    });
    return { applied: true };
  };

  /**
   * Focus window (bring to front)
   */
  const focus = async (params: OperationParamMap['window.focus']): Promise<{ applied: boolean }> => {
    const record = windows.get(params.id);
    if (!record) {
      throw new AdapterError('Adapter.WindowNotFound', `Window not found: ${params.id}`);
    }

    // Calculate max z-index of existing windows
    let maxZ = 1000;
    for (const [otherId, other] of windows) {
      if (otherId === params.id) continue;
      const computed = window.getComputedStyle(other.wrapper);
      const z = parseInt(computed.zIndex, 10);
      if (!isNaN(z) && z > maxZ) maxZ = z;
    }

    applyWindowGeometry(record, {
      zIndex: maxZ + 1,
    });
    return { applied: true };
  };

  /**
   * Close window
   */
  const close = async (params: OperationParamMap['window.close']): Promise<{ applied: boolean }> => {
    destroyWindow(params.id);
    return { applied: true };
  };

  /**
   * Check if window exists
   */
  const exists = (id: WindowId): boolean => {
    return windows.has(id);
  };

  /**
   * List all windows
   */
  const list = (): Array<{ id: string; title: string }> => {
    return Array.from(windows.values()).map((record) => ({
      id: record.id,
      title: record.titleText.textContent ?? record.id,
    }));
  };

  /**
   * Get window record (for internal use)
   */
  const getRecord = (id: WindowId): WindowRecord | undefined => {
    return windows.get(id);
  };

  return {
    create,
    move,
    resize,
    focus,
    close,
    exists,
    list,
    getRecord,
  };
};
