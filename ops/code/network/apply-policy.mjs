#!/usr/bin/env node
// =============================================================
// OPS-ONLY SCRIPT — DO NOT RUN ON END-USER MACHINES
// This script modifies host firewall settings when explicitly enabled.
// It MUST NOT be invoked by the application runtime or regular users.
// To proceed, you must set BOTH env vars:
//   UICP_ALLOW_HOST_FW=1
//   UICP_HOST_FW_I_UNDERSTAND=YES
// Otherwise, this script will exit without making changes.
// =============================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    p.on('exit', (code) => {
      if (code === 0) resolve(); else reject(new Error(`${cmd} exited with ${code}`));
    });
    p.on('error', reject);
  });
}

async function main() {
  const allow = process.env.UICP_ALLOW_HOST_FW === '1';
  const confirm = (process.env.UICP_HOST_FW_I_UNDERSTAND || '').toUpperCase() === 'YES';
  if (!allow || !confirm) {
    console.error('[uicp-fw] Host firewall apply disabled. Set UICP_ALLOW_HOST_FW=1 and UICP_HOST_FW_I_UNDERSTAND=YES to proceed.');
    process.exit(3);
  }
  const plat = process.platform; // 'linux' | 'darwin' | 'win32'
  const root = path.resolve(path.join(__dirname));
  const updateScript = path.join(root, 'update-lists.mjs');

  if (plat === 'linux') {
    // Generate sets and apply nftables
    await run(process.execPath, [updateScript], { cwd: path.dirname(root) });
    const applySh = path.join(root, 'linux', 'apply-nftables.sh');
    await run('bash', [applySh], { env: { ...process.env, FIREWALL_FINALIZE: '1' } });
    return;
  }

  if (plat === 'darwin') {
    // Generate pf table files, load anchor and refresh tables
    await run(process.execPath, [updateScript], { cwd: path.dirname(root) });
    const anchorConf = path.join(root, 'macos', 'anchor.conf');
    await run('sudo', ['pfctl', '-a', 'com.uicp.fw', '-f', anchorConf]);
    const refreshSh = path.join(root, 'macos', 'refresh-tables.sh');
    await run('sudo', ['bash', refreshSh]);
    return;
  }

  if (plat === 'win32') {
    // Install base rules and update dynamic lists
    const installPs1 = path.join(root, 'windows', 'Install-UICPRules.ps1');
    const updatePs1 = path.join(root, 'windows', 'Update-UICPDynamicLists.ps1');
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installPs1, '-RegisterScheduledTask:$true']);
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updatePs1]);
    return;
  }

  console.error(`[uicp-fw] Unsupported platform: ${plat}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(`[uicp-fw] apply-policy failed:`, e?.message || e);
  process.exit(1);
});
