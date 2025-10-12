import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function withCargoInPath(baseEnv) {
  const env = { ...baseEnv };
  const isWin = process.platform === 'win32';
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const sep = isWin ? ';' : ':';
  const cargoHome = env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const cargoBin = path.join(cargoHome, 'bin');
  const current = env[pathKey] || '';
  const parts = current
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean);
  const hasCargo = parts.some(
    (p) => (isWin ? p.toLowerCase() : p) === (isWin ? cargoBin.toLowerCase() : cargoBin),
  );
  if (!hasCargo) env[pathKey] = current ? `${cargoBin}${sep}${current}` : cargoBin;
  return env;
}

const env = withCargoInPath({
  ...process.env,
  UICP_MODULES_DIR: process.env.UICP_MODULES_DIR || 'src-tauri/modules',
});

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(npxCmd, ['tauri', 'dev'], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
