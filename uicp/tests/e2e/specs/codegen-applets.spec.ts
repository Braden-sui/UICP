import { test, expect } from '@playwright/test';

const GRID_TS_SOURCE = `// scenario:grid-game
type Player = "X" | "O";
interface GridState { board: (Player | null)[]; turn: Player; winner: Player | "draw" | null; }
const applet = {
  init(): string {
    const state: GridState = { board: Array(9).fill(null), turn: "X", winner: null };
    return JSON.stringify(state);
  },
  render(stateStr: string): string {
    const state: GridState = JSON.parse(stateStr || "{}");
    return "<div class=\"grid-game\">Generated grid game UI</div>";
  },
  onEvent(_action: string, _payload: string, stateStr: string): string {
    return JSON.stringify({ next_state: stateStr });
  }
};
export default applet;
`;

const NOTES_TS_SOURCE = `// scenario:notes-app
interface Note { id: string; text: string }
interface NotesState { notes: Note[]; nextId: number; lastSavedAt: string | null }
const applet = {
  init(): string {
    const initial: NotesState = { notes: [], nextId: 1, lastSavedAt: null };
    return JSON.stringify(initial);
  },
  render(stateStr: string): string {
    const state: NotesState = JSON.parse(stateStr || "{}");
    return "<div class=\"notes-app\">Generated notes UI</div>";
  },
  onEvent(action: string, payload: string, stateStr: string): string {
    const snapshot = { next_state: stateStr, action, payload };
    return JSON.stringify(snapshot);
  }
};
export default applet;
`;

const GRID_SPEC_TEXT = 'Generate a TypeScript script.panel that plays tic tac toe with buttons and announces the winner.';
const NOTES_SPEC_TEXT = 'Generate a TypeScript script.panel notes tool with add/delete/save actions that writes to tauri://fs/writeTextFile.';

test.describe('Agent code generation applets', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ gridCode, notesCode }) => {
      const scenarioSources = new Map<string, 'grid' | 'notes'>();
      const cacheHitsKey = '__uicp_test_cache_hits__';
      const loadCacheHits = (): Array<[string, boolean]> => {
        try {
          const raw = sessionStorage.getItem(cacheHitsKey);
          if (!raw) return [];
          const parsed = JSON.parse(raw) as Record<string, boolean>;
          return Object.entries(parsed) as Array<[string, boolean]>;
        } catch (err) {
          console.warn('[test-compute] cacheHits load failed', err);
          return [];
        }
      };
      const cacheHits = new Map<string, boolean>(loadCacheHits());
      const persistCacheHits = () => {
        try {
          const entries = Array.from(cacheHits.entries());
          sessionStorage.setItem(cacheHitsKey, JSON.stringify(Object.fromEntries(entries)));
        } catch (err) {
          console.warn('[test-compute] cacheHits persist failed', err);
        }
      };
      const cancelled = new Set<string>();

      const markScenario = (code: string, scenario: 'grid' | 'notes') => {
        scenarioSources.set(code, scenario);
        scenarioSources.set(code.trim(), scenario);
      };

      const ensureScenario = (code: string, fallback: 'grid' | 'notes'): 'grid' | 'notes' => {
        if (code.includes('scenario:grid')) return 'grid';
        if (code.includes('scenario:notes')) return 'notes';
        return fallback;
      };

      const parseJson = <T,>(value: string, fallback: T): T => {
        try {
          return JSON.parse(value) as T;
        } catch (err) {
          console.warn('[test-compute] JSON parse failed', err);
          return fallback;
        }
      };

      const defaultGridState = () => ({ board: Array(9).fill(null), turn: 'X', winner: null as 'X' | 'O' | 'draw' | null, moves: 0 });

      const winningLines: Array<[number, number, number]> = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],
        [0, 4, 8],
        [2, 4, 6],
      ];

      const evaluateWinner = (board: Array<'X' | 'O' | null>) => {
        for (const [a, b, c] of winningLines) {
          const mark = board[a];
          if (mark && mark === board[b] && mark === board[c]) {
            return mark;
          }
        }
        return board.every((cell) => cell !== null) ? 'draw' : null;
      };

      const renderGrid = (state: ReturnType<typeof defaultGridState>) => {
        const cells = state.board
          .map((mark, index) => {
            const label = mark ?? '&nbsp;';
            const payload = JSON.stringify({ index });
            return `<button class="grid-cell" data-testid="grid-cell-${index}" data-command='{"type":"script.emit","action":"move","payload":${payload}}'>${label}</button>`;
          })
          .reduce<Array<string>>((rows, cell, idx) => {
            if (idx % 3 === 0) rows.push('<div class="grid-row">');
            rows[rows.length - 1] += cell;
            if (idx % 3 === 2) rows[rows.length - 1] += '</div>';
            return rows;
          }, []);
        const status = state.winner ? (state.winner === 'draw' ? 'Draw' : `${state.winner} wins`) : `Turn: ${state.turn}`;
        return `<div class="grid-game"><div class="grid-board" data-testid="grid-board">${cells.join('')}</div><div class="grid-status" data-testid="grid-status">${status}</div></div>`;
      };

      type NotesState = { notes: Array<{ id: string; text: string }>; nextId: number; lastSavedAt: string | null };

      const defaultNotesState = (): NotesState => ({ notes: [], nextId: 1, lastSavedAt: null });

      const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

      const renderNotes = (state: NotesState) => {
        const items = state.notes.length
          ? state.notes
              .map((note) => {
                const escaped = escapeHtml(note.text);
                return `<li data-testid="note-item"><span class="note-text">${escaped}</span><button type="button" data-testid="delete-note-${note.id}" data-command='{"type":"script.emit","action":"delete","payload":{"id":"${note.id}"}}'>Delete</button></li>`;
              })
              .join('')
          : '<li data-testid="notes-empty">No notes yet</li>';
        const status = state.lastSavedAt ? `Last saved: ${escapeHtml(state.lastSavedAt)}` : 'Not saved yet';
        return `<div class="notes-app"><form data-testid="notes-form" data-command='{"type":"script.emit","action":"add","payload":{"text":"{{form.note}}"}}'><input name="note" data-testid="note-input" placeholder="New note" /><button type="submit" data-testid="add-note">Add</button></form><ul data-testid="note-list">${items}</ul><button type="button" data-command='{"type":"script.emit","action":"save"}' data-testid="save-notes">Save</button><div data-testid="save-status">${status}</div></div>`;
      };

      window.__UICP_TEST_COMPUTE__ = async (spec) => {
        const task = String(spec.task ?? '');
        if (task.startsWith('codegen.run@')) {
          const input = (spec.input ?? {}) as Record<string, unknown>;
          const constraints = (input.constraints ?? {}) as Record<string, unknown>;
          const mock = (constraints.mockResponse ?? {}) as Record<string, unknown>;
          const code = typeof mock.code === 'string' ? mock.code : (ensureScenario(String(input.spec ?? ''), 'grid') === 'grid' ? gridCode : notesCode);
          const scenario = ensureScenario(code, 'grid');
          markScenario(code, scenario);
          const cacheHit = cacheHits.get(scenario) === true;
          cacheHits.set(scenario, true);
          persistCacheHits();
          queueMicrotask(() => {
            window.dispatchEvent(
              new CustomEvent('uicp-compute-final', {
                detail: {
                  ok: true,
                  jobId: spec.jobId,
                  task,
                  output: {
                    code,
                    language: 'ts',
                    meta: {
                      provider: 'mock:e2e',
                      scenario,
                    },
                  },
                  metrics: { cacheHit },
                },
              }),
            );
          });
          return;
        }

        if (task === 'applet.quickjs@0.1.0') {
          if (cancelled.has(spec.jobId)) {
            queueMicrotask(() => {
              window.dispatchEvent(
                new CustomEvent('uicp-compute-final', {
                  detail: {
                    ok: false,
                    jobId: spec.jobId,
                    task,
                    code: 'Compute.Cancelled',
                    message: 'cancelled',
                  },
                }),
              );
            });
            return;
          }

          const input = (spec.input ?? {}) as Record<string, unknown>;
          const mode = String(input.mode ?? '').toLowerCase();
          const source = typeof input.source === 'string' ? input.source : '';
          const scenario = scenarioSources.get(source.trim()) ?? ensureScenario(source, 'grid');
          const stateStr = typeof input.state === 'string' ? input.state : '';
          const action = typeof input.action === 'string' ? input.action : '';
          const payloadStr = typeof input.payload === 'string' ? input.payload : '';

          if (scenario === 'grid') {
            if (mode === 'init') {
              const initial = JSON.stringify(defaultGridState());
              queueMicrotask(() => {
                window.dispatchEvent(
                  new CustomEvent('uicp-compute-final', {
                    detail: {
                      ok: true,
                      jobId: spec.jobId,
                      task,
                      output: { status: 'ready', mode: 'init', data: initial },
                      metrics: {},
                    },
                  }),
                );
              });
              return;
            }

            if (mode === 'render') {
              const parsed = parseJson(stateStr, defaultGridState());
              const html = renderGrid(parsed);
              queueMicrotask(() => {
                window.dispatchEvent(
                  new CustomEvent('uicp-compute-final', {
                    detail: {
                      ok: true,
                      jobId: spec.jobId,
                      task,
                      output: { status: 'ready', mode: 'render', html },
                      metrics: {},
                    },
                  }),
                );
              });
              return;
            }

            if (mode === 'on-event') {
              const parsed = parseJson(stateStr, defaultGridState());
              if (!parsed.winner && action === 'move') {
                const payload = parseJson(payloadStr, { index: -1 });
                const index = Number(payload?.index ?? -1);
                if (Number.isInteger(index) && index >= 0 && index < parsed.board.length && parsed.board[index] === null) {
                  parsed.board[index] = parsed.turn;
                  parsed.turn = parsed.turn === 'X' ? 'O' : 'X';
                  parsed.winner = evaluateWinner(parsed.board);
                }
              }
              const nextState = JSON.stringify(parsed);
              queueMicrotask(() => {
                window.dispatchEvent(
                  new CustomEvent('uicp-compute-final', {
                    detail: {
                      ok: true,
                      jobId: spec.jobId,
                      task,
                      output: { status: 'ready', mode: 'on-event', data: JSON.stringify({ next_state: nextState }) },
                      metrics: {},
                    },
                  }),
                );
              });
              return;
            }
          }

          if (scenario === 'notes') {
            if (mode === 'init') {
              const initial = JSON.stringify(defaultNotesState());
              queueMicrotask(() => {
                window.dispatchEvent(
                  new CustomEvent('uicp-compute-final', {
                    detail: {
                      ok: true,
                      jobId: spec.jobId,
                      task,
                      output: { status: 'ready', mode: 'init', data: initial },
                      metrics: {},
                    },
                  }),
                );
              });
              return;
            }

            if (mode === 'render') {
              const parsed = parseJson<NotesState>(stateStr, defaultNotesState());
              const html = renderNotes(parsed);
              queueMicrotask(() => {
                window.dispatchEvent(
                  new CustomEvent('uicp-compute-final', {
                    detail: {
                      ok: true,
                      jobId: spec.jobId,
                      task,
                      output: { status: 'ready', mode: 'render', html },
                      metrics: {},
                    },
                  }),
                );
              });
              return;
            }

            if (mode === 'on-event') {
              const parsed = parseJson<NotesState>(stateStr, defaultNotesState());
              const payload = parseJson<Record<string, unknown>>(payloadStr, {});
              if (action === 'add') {
                const text = String(payload?.text ?? '').trim();
                if (text) {
                  parsed.notes = [...parsed.notes, { id: String(parsed.nextId), text }];
                  parsed.nextId += 1;
                }
              } else if (action === 'delete') {
                const id = String(payload?.id ?? '');
                parsed.notes = parsed.notes.filter((note) => note.id !== id);
              } else if (action === 'save') {
                parsed.lastSavedAt = new Date().toISOString();
              }
              const nextState = JSON.stringify(parsed);
              queueMicrotask(() => {
                window.dispatchEvent(
                  new CustomEvent('uicp-compute-final', {
                    detail: {
                      ok: true,
                      jobId: spec.jobId,
                      task,
                      output: {
                        status: 'ready',
                        mode: 'on-event',
                        data: JSON.stringify({
                          next_state: nextState,
                          batch:
                            action === 'save'
                              ? [
                                  {
                                    op: 'api.call',
                                    params: {
                                      method: 'POST',
                                      url: 'tauri://fs/writeTextFile',
                                      body: {
                                        path: 'ws:/files/uicp-notes.json',
                                        contents: JSON.stringify(parsed.notes),
                                      },
                                    },
                                  },
                                ]
                              : undefined,
                        }),
                      },
                      metrics: {},
                    },
                  }),
                );
              });
              return;
            }
          }

          throw new Error(`Unhandled script mode: ${mode} (${scenario})`);
        }

        throw new Error(`Unsupported task ${task}`);
      };

      window.__UICP_TEST_COMPUTE_CANCEL__ = async (jobId: string) => {
        cancelled.add(jobId);
      };
    }, { gridCode: GRID_TS_SOURCE, notesCode: NOTES_TS_SOURCE });

    await page.goto('/');
    await page.evaluate(() => {
      const store = (window as typeof window & { __UICP_APP_STORE__?: typeof import('../../../src/state/app').useAppStore }).__UICP_APP_STORE__;
      store?.getState?.().setSafeMode(false);
    });
  });

  test('grid game scenario ends with X win', async ({ page }) => {
    await page.waitForFunction(() => typeof (window as typeof window & { __UICP_TEST_ENQUEUE__?: unknown }).__UICP_TEST_ENQUEUE__ === 'function');

    await page.evaluate(
      async ({ gridCode, specText }) => {
        const enqueue = (window as typeof window & { __UICP_TEST_ENQUEUE__: (batch: unknown) => Promise<unknown> }).__UICP_TEST_ENQUEUE__;
        await enqueue([
          { op: 'window.create', params: { id: 'win-code-grid', title: 'Grid Game', size: 'md' } },
          {
            op: 'dom.set',
            params: {
              windowId: 'win-code-grid',
              target: '#root',
              sanitize: true,
              html: '<div data-testid="grid-progress"></div>',
            },
          },
          {
            op: 'needs.code',
            params: {
              spec: specText,
              language: 'ts',
              artifactId: 'grid-game-applet',
              progressWindowId: 'win-code-grid',
              progressSelector: '[data-testid="grid-progress"]',
              constraints: {
                mockResponse: {
                  code: gridCode,
                  language: 'ts',
                  meta: { provider: 'mock:e2e' },
                },
              },
              install: {
                panelId: 'panel-grid-game',
                windowId: 'win-code-grid',
                target: '#root',
              },
            },
          },
        ]);
      },
      { gridCode: GRID_TS_SOURCE, specText: GRID_SPEC_TEXT },
    );

    const gridWindow = page.locator('[data-desktop-window="win-code-grid"]');
    const progressSelector = '[data-desktop-window="win-code-grid"] [data-testid="grid-progress"]';
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && el.textContent?.includes('Code ready');
      },
      progressSelector,
    );
    const installButton = gridWindow.getByRole('button', { name: 'Install to panel' });
    await expect(installButton).toBeVisible();

    const viewButton = gridWindow.getByRole('button', { name: 'View code' });
    await expect(viewButton).toBeVisible();
    await viewButton.click();
    await expect(page.locator('[data-desktop-window="win-artifacts-grid-game-applet-view"]')).toBeVisible();

    await installButton.click();

    const panel = page.locator('.uicp-script-panel[data-script-panel-id="panel-grid-game"]');
    await expect(panel).toBeVisible();

    const clickOrder = [0, 3, 1, 4, 2];
    for (const index of clickOrder) {
      await panel.locator(`[data-testid="grid-cell-${index}"]`).click();
    }

    await expect(panel.locator('[data-testid="grid-status"]')).toHaveText('X wins');
  });

  test('safe mode blocks needs.code until disabled and provider select toggles', async ({ page }) => {
    await page.waitForFunction(() => typeof (window as typeof window & { __UICP_TEST_ENQUEUE__?: unknown }).__UICP_TEST_ENQUEUE__ === 'function');
    await page.evaluate(() => {
      const store = (window as typeof window & { __UICP_APP_STORE__?: typeof import('../../../src/state/app').useAppStore }).__UICP_APP_STORE__;
      store?.getState?.().setSafeMode(false);
    });
    await page.waitForFunction(() => {
      const store = (window as typeof window & { __UICP_APP_STORE__?: typeof import('../../../src/state/app').useAppStore }).__UICP_APP_STORE__;
      return Boolean(store?.getState);
    });
    await page.evaluate(() => {
      const store = (window as typeof window & { __UICP_APP_STORE__?: typeof import('../../../src/state/app').useAppStore }).__UICP_APP_STORE__;
      store?.getState?.().setAgentSettingsOpen(true);
    });

    const settingsWindow = page.locator('[data-desktop-window="agent-settings"]');
    await expect(settingsWindow).toBeVisible();

    const runBothCheckbox = settingsWindow.getByLabel('Allow needs.code to try both providers before falling back');
    if (await runBothCheckbox.isChecked()) {
      await runBothCheckbox.uncheck();
    }
    const providerSelect = settingsWindow.getByLabel('Default provider');
    await providerSelect.selectOption('claude');
    await expect(providerSelect).toHaveValue('claude');
    await providerSelect.selectOption('codex');
    await expect(providerSelect).toHaveValue('codex');

    const safeModeCheckbox = settingsWindow.getByLabel('Disable codegen (Safe Mode)');
    await safeModeCheckbox.check();

    await page.evaluate(
      async ({ gridCode, specText }) => {
        const enqueue = (window as typeof window & { __UICP_TEST_ENQUEUE__: (batch: unknown) => Promise<unknown> }).__UICP_TEST_ENQUEUE__;
        await enqueue([
          { op: 'window.create', params: { id: 'win-safe-mode', title: 'Safe Mode', size: 'sm' } },
          {
            op: 'dom.set',
            params: {
              windowId: 'win-safe-mode',
              target: '#root',
              sanitize: true,
              html: '<div data-testid="safe-progress"></div>',
            },
          },
          {
            op: 'needs.code',
            params: {
              spec: specText,
              language: 'ts',
              artifactId: 'safe-mode-applet',
              progressWindowId: 'win-safe-mode',
              progressSelector: '[data-testid="safe-progress"]',
              constraints: {
                mockResponse: {
                  code: gridCode,
                  language: 'ts',
                  meta: { provider: 'mock:e2e' },
                },
              },
              install: {
                panelId: 'panel-safe-mode',
                windowId: 'win-safe-mode',
                target: '#root',
              },
            },
          },
        ]);
      },
      { gridCode: GRID_TS_SOURCE, specText: GRID_SPEC_TEXT },
    );

    const safeProgress = page.locator('[data-desktop-window="win-safe-mode"] [data-testid="safe-progress"]');
    await expect(safeProgress).toContainText('Safe Mode is on');

    await safeModeCheckbox.uncheck();
    await page.evaluate(
      async ({ gridCode, specText }) => {
        const enqueue = (window as typeof window & { __UICP_TEST_ENQUEUE__: (batch: unknown) => Promise<unknown> }).__UICP_TEST_ENQUEUE__;
        await enqueue([
          {
            op: 'dom.set',
            params: {
              windowId: 'win-safe-mode',
              target: '#root',
              sanitize: true,
              html: '<div data-testid="safe-progress"></div>',
            },
          },
          {
            op: 'needs.code',
            params: {
              spec: specText,
              language: 'ts',
              artifactId: 'safe-mode-applet',
              progressWindowId: 'win-safe-mode',
              progressSelector: '[data-testid="safe-progress"]',
              constraints: {
                mockResponse: {
                  code: gridCode,
                  language: 'ts',
                  meta: { provider: 'mock:e2e' },
                },
              },
              install: {
                panelId: 'panel-safe-mode',
                windowId: 'win-safe-mode',
                target: '#root',
              },
            },
          },
        ]);
      },
      { gridCode: GRID_TS_SOURCE, specText: GRID_SPEC_TEXT },
    );

    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && el.textContent?.includes('Code ready');
      },
      '[data-desktop-window="win-safe-mode"] [data-testid="safe-progress"]',
    );

    const installSafe = page.locator('[data-desktop-window="win-safe-mode"]').getByRole('button', { name: 'Install to panel' });
    await installSafe.click();
    const safePanel = page.locator('.uicp-script-panel[data-script-panel-id="panel-safe-mode"]');
    await expect(safePanel).toBeVisible();

    await page.evaluate(() => {
      const store = (window as typeof window & { __UICP_APP_STORE__?: typeof import('../../../src/state/app').useAppStore }).__UICP_APP_STORE__;
      store?.getState?.().setAgentSettingsOpen(false);
      store?.getState?.().setSafeMode(false);
    });
  });

  test('artifact persistence hits golden cache after reload', async ({ page }) => {
    await page.waitForFunction(() => typeof (window as typeof window & { __UICP_TEST_ENQUEUE__?: unknown }).__UICP_TEST_ENQUEUE__ === 'function');

    const runNeedsCode = async () => {
      await page.evaluate(
        async ({ gridCode, specText }) => {
          const enqueue = (window as typeof window & { __UICP_TEST_ENQUEUE__: (batch: unknown) => Promise<unknown> }).__UICP_TEST_ENQUEUE__;
          await enqueue([
            { op: 'window.create', params: { id: 'win-cache', title: 'Cached Grid', size: 'md' } },
            {
              op: 'dom.set',
              params: {
                windowId: 'win-cache',
                target: '#root',
                sanitize: true,
                html: '<div data-testid="cache-progress"></div>',
              },
            },
            {
              op: 'needs.code',
              params: {
                spec: specText,
                language: 'ts',
                artifactId: 'grid-cache-applet',
                progressWindowId: 'win-cache',
                progressSelector: '[data-testid="cache-progress"]',
                constraints: {
                  mockResponse: {
                    code: gridCode,
                    language: 'ts',
                    meta: { provider: 'mock:e2e' },
                  },
                },
                install: {
                  panelId: 'panel-grid-cache',
                  windowId: 'win-cache',
                  target: '#root',
                },
              },
            },
          ]);
        },
        { gridCode: GRID_TS_SOURCE, specText: GRID_SPEC_TEXT },
      );
    };

    await runNeedsCode();
    const cacheProgressSelector = '[data-desktop-window="win-cache"] [data-testid="cache-progress"]';
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && el.textContent?.includes('Code ready');
      },
      cacheProgressSelector,
    );

    const installCache = page.locator('[data-desktop-window="win-cache"]').getByRole('button', { name: 'Install to panel' });
    await installCache.click();
    const cachePanel = page.locator('.uicp-script-panel[data-script-panel-id="panel-grid-cache"]');
    await expect(cachePanel).toBeVisible();

    await page.reload();
    await page.waitForFunction(() => typeof (window as typeof window & { __UICP_TEST_ENQUEUE__?: unknown }).__UICP_TEST_ENQUEUE__ === 'function');

    const start = Date.now();
    await runNeedsCode();
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return !!el && el.textContent?.includes('cached result');
      },
      cacheProgressSelector,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);

    const installCacheAgain = page.locator('[data-desktop-window="win-cache"]').getByRole('button', { name: 'Install to panel' });
    await installCacheAgain.click();
    const cachePanelAfterReload = page.locator('.uicp-script-panel[data-script-panel-id="panel-grid-cache"]');
    await expect(cachePanelAfterReload).toBeVisible();
    await expect(cachePanelAfterReload.locator('[data-testid="grid-board"]')).toBeVisible();
  });

  test('notes scenario add/delete/save flow', async ({ page }) => {
    await page.waitForFunction(() => typeof (window as typeof window & { __UICP_TEST_ENQUEUE__?: unknown }).__UICP_TEST_ENQUEUE__ === 'function');

    await page.evaluate(
      async ({ notesCode, specText }) => {
        const enqueue = (window as typeof window & { __UICP_TEST_ENQUEUE__: (batch: unknown) => Promise<unknown> }).__UICP_TEST_ENQUEUE__;
        await enqueue([
          { op: 'window.create', params: { id: 'win-code-notes', title: 'Notes', size: 'md' } },
          {
            op: 'dom.set',
            params: {
              windowId: 'win-code-notes',
              target: '#root',
              sanitize: true,
              html: '<div data-testid="notes-progress"></div>',
            },
          },
          {
            op: 'needs.code',
            params: {
              spec: specText,
              language: 'ts',
              artifactId: 'notes-applet',
              progressWindowId: 'win-code-notes',
              progressSelector: '[data-testid="notes-progress"]',
              constraints: {
                mockResponse: {
                  code: notesCode,
                  language: 'ts',
                  meta: { provider: 'mock:e2e' },
                },
              },
              install: {
                panelId: 'panel-notes',
                windowId: 'win-code-notes',
                target: '#root',
              },
            },
          },
        ]);
      },
      { notesCode: NOTES_TS_SOURCE, specText: NOTES_SPEC_TEXT },
    );

    const notesWindow = page.locator('[data-desktop-window="win-code-notes"]');
    const installButton = notesWindow.getByRole('button', { name: 'Install to panel' });
    await expect(installButton).toBeVisible();

    const viewButton = notesWindow.getByRole('button', { name: 'View code' });
    await expect(viewButton).toBeVisible();
    await viewButton.click();
    await expect(page.locator('[data-desktop-window="win-artifacts-notes-applet-view"]')).toBeVisible();

    await installButton.click();

    const panel = page.locator('.uicp-script-panel[data-script-panel-id="panel-notes"]');
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="note-input"]').fill('First note');
    await panel.locator('[data-testid="add-note"]').click();
    await expect(panel.locator('[data-testid="note-item"]')).toHaveCount(1);

    await panel.locator('[data-testid="delete-note-1"]').click();
    await expect(panel.locator('[data-testid="note-item"]')).toHaveCount(0);

    await panel.locator('[data-testid="save-notes"]').click();
    await expect(panel.locator('[data-testid="save-status"]')).toContainText('Last saved:');
  });
});

