import { describe, it, beforeEach, expect } from 'vitest';
import { registerWorkspaceRoot, listWorkspaceWindows, applyBatch } from '../../../src/lib/uicp/adapter';
import { parseWILBatch } from '../../../src/lib/orchestrator/parseWILBatch';
import { validateBatch } from '../../../src/lib/uicp/schemas';
import { getTauriMocks } from '../../mocks/tauri';

const getRuleStyle = (selector: string): CSSStyleDeclaration => {
  const sheets = Array.from(document.styleSheets) as CSSStyleSheet[];
  for (const sheet of sheets) {
    const rule = Array.from(sheet.cssRules).find(
      (cssRule): cssRule is CSSStyleRule =>
        cssRule instanceof CSSStyleRule && cssRule.selectorText === selector,
    );
    if (rule) return rule.style;
  }
  throw new Error(`Style rule ${selector} missing`);
};

describe('LLM-bypass window smoke test', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'workspace-root';
    document.body.appendChild(root);
    registerWorkspaceRoot(root);
    getTauriMocks(); // install invoke stub for persistence hooks
  });

  it('creates a blank window via direct WIL', async () => {
    const wil = `create window title SmokeTest width 320 height 200`;
    const batchLike = parseWILBatch(wil).filter((i): i is { op: string; params: any } => 'op' in i);
    const batch = validateBatch(batchLike);
    const outcome = await applyBatch(batch);

    expect(outcome.success).toBe(true);
    const windows = listWorkspaceWindows();
    const smoke = windows.find(w => w.title === 'SmokeTest');
    expect(smoke?.id).toBeTruthy();

    const el = document.querySelector(`[data-window-id="${smoke!.id}"]`) as HTMLElement | null;
    expect(el).not.toBeNull();
    const style = getRuleStyle(`[data-window-id="${smoke!.id}"]`);
    expect(style.width).toBe('320px');
    expect(style.height).toBe('200px');
  });
});
