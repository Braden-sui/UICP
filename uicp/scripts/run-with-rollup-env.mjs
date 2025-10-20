#!/usr/bin/env node
/**
 * Cross-platform helper that ensures ROLLUP_SKIP_NODE_NATIVE is set before
 * delegating to the provided command. We spawn via the platform shell so that
 * regular pnpm/vitest binaries resolve the same way `pnpm run` does.
 */
import { spawn } from 'node:child_process';

const [, , command, ...args] = process.argv;

if (!command) {
  console.error('Usage: node scripts/run-with-rollup-env.mjs <command> [..args]');
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ROLLUP_SKIP_NODE_NATIVE: 'true',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[run-with-rollup-env] failed to spawn command:', error);
  process.exit(1);
});
