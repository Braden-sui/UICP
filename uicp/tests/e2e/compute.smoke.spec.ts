import { test, expect } from '@playwright/test';
import type { JobSpec } from '../../src/compute/types';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

type ComputeSpec = JobSpec;

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '../../..');
const cargoManifest = join(repoRoot, 'uicp', 'src-tauri', 'Cargo.toml');

test.describe('compute harness via headless host', () => {
  let dataDir: string;
  const pending = new Map<string, ReturnType<typeof spawn>>();

  test.beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'compute-e2e-'));
  });

  test.afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await page.exposeFunction('uicpNodeRunCompute', async (spec: ComputeSpec) => {
      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(
          'cargo',
          [
            'run',
            '--quiet',
            '--manifest-path',
            cargoManifest,
            '--features',
            'compute_harness',
            '--bin',
            'compute_harness',
            '--',
            'run',
            '--data-dir',
            dataDir,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );

        pending.set(spec.jobId, child);

        let stdout = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', (err) => {
          pending.delete(spec.jobId);
          rejectPromise(err);
        });

        child.on('exit', (code) => {
          pending.delete(spec.jobId);
          if (code === 0) {
            try {
              const trimmed = stdout.trim();
              resolvePromise(trimmed ? JSON.parse(trimmed) : {});
            } catch (err) {
              rejectPromise(err);
            }
          } else {
            rejectPromise(new Error(`compute_harness exited with code ${code}: ${stderr}`));
          }
        });

        child.stdin.write(`${JSON.stringify(spec)}\n`);
      });
    });

    await page.exposeFunction('uicpNodeCancelCompute', async (jobId: string) => {
      const child = pending.get(jobId);
      if (!child || !child.stdin.writable) return false;
      return new Promise<boolean>((resolvePromise) => {
        child.stdin.write('cancel\n', (err) => {
          if (err) {
            resolvePromise(false);
          } else {
            resolvePromise(true);
          }
        });
      });
    });

    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalAny = window as any;
      globalAny.__UICP_TEST_COMPUTE__ = (spec: ComputeSpec) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).uicpNodeRunCompute(spec);
      globalAny.__UICP_TEST_COMPUTE_CANCEL__ = (jobId: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).uicpNodeCancelCompute(jobId);
    });

    await page.goto('/');
  });

  test.afterEach(async () => {
    for (const child of pending.values()) {
      child.kill();
    }
    pending.clear();
  });

  test('csv.parse success applies binding and reports cache hit on replay', async ({ page }) => {
    const jobId1 = crypto.randomUUID();
    const source = 'data:text/csv,name,score\nAlice,10\nBob,20';
    const envHash = 'compute-e2e';

    await page.evaluate(
      ({ jobId, source }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).uicpComputeCall({
          jobId,
          task: 'csv.parse@1.2.0',
          input: { source, hasHeader: true },
          cache: 'readwrite',
          bind: [{ toStatePath: '/tables/sales' }],
          provenance: { envHash: 'compute-e2e' },
        }),
      { jobId: jobId1, source },
    );

    await page.waitForFunction(
      (jobId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__UICP_COMPUTE_STORE__;
        return store.getState().jobs[jobId]?.status === 'done';
      },
      jobId1,
      { timeout: 2000 },
    );

    const firstRun = await page.evaluate((jobId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__UICP_COMPUTE_STORE__;
      return store.getState().jobs[jobId];
    }, jobId1);
    expect(firstRun.cacheHit).toBeFalsy();

    const boundValue = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stateStore = (window as any).__UICP_STATE_STORE__;
      return stateStore.get('workspace')?.get('/tables/sales');
    });
    expect(boundValue).toEqual({
      rows: [
        ['name', 'score'],
        ['Alice', '10'],
        ['Bob', '20'],
      ],
    });

    const jobId2 = crypto.randomUUID();
    await page.evaluate(
      ({ jobId, source, envHash }) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).uicpComputeCall({
          jobId,
          task: 'csv.parse@1.2.0',
          input: { source, hasHeader: true },
          cache: 'readwrite',
          bind: [{ toStatePath: '/tables/cache-replay' }],
          provenance: { envHash },
        }),
      { jobId: jobId2, source, envHash },
    );

    await page.waitForFunction(
      (jobId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__UICP_COMPUTE_STORE__;
        return store.getState().jobs[jobId]?.status === 'done';
      },
      jobId2,
      { timeout: 2000 },
    );

    const secondRun = await page.evaluate((jobId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__UICP_COMPUTE_STORE__;
      return store.getState().jobs[jobId];
    }, jobId2);
    expect(secondRun.cacheHit).toBeTruthy();
    expect(secondRun.durationMs).toBeGreaterThanOrEqual(70);

    const replayValue = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stateStore = (window as any).__UICP_STATE_STORE__;
      return stateStore.get('workspace')?.get('/tables/cache-replay');
    });
    expect(replayValue).toEqual(boundValue);
  });

  test('cancelling in-flight job yields Compute.Cancelled', async ({ page }) => {
    const jobId = crypto.randomUUID();
    const source = 'data:text/csv,a,b\n1,2';

    await page.evaluate(
      ({ jobId, source }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).uicpComputeCall({
          jobId,
          task: 'csv.parse@1.2.0',
          input: { source, hasHeader: true },
          cache: 'readwrite',
          provenance: { envHash: 'compute-cancel' },
        });
        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).uicpComputeCancel(jobId);
        }, 20);
      },
      { jobId, source },
    );

    await page.waitForFunction(
      (jobId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__UICP_COMPUTE_STORE__;
        return store.getState().jobs[jobId]?.status === 'cancelled';
      },
      jobId,
      { timeout: 2000 },
    );

    const cancelled = await page.evaluate((jobId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__UICP_COMPUTE_STORE__;
      return store.getState().jobs[jobId];
    }, jobId);

    expect(cancelled.lastError).toContain('cancelled');
  });
});
