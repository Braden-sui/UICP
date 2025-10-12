const { existsSync, readdirSync, renameSync } = require('node:fs');
const { join } = require('node:path');

function ensureRollupNativeBinding() {
  if (process.platform !== 'win32') {
    return;
  }
  const baseDir = join(process.cwd(), 'node_modules', '@rollup');
  const targetDir = join(baseDir, 'rollup-win32-x64-msvc');
  if (existsSync(targetDir)) {
    return;
  }
  if (!existsSync(baseDir)) {
    return;
  }
  const entries = readdirSync(baseDir, { withFileTypes: true });
  const staging = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith('.rollup-win32-x64-msvc'),
  );
  if (!staging) {
    return;
  }
  const stagingPath = join(baseDir, staging.name);
  try {
    renameSync(stagingPath, targetDir);
    // eslint-disable-next-line no-console
    console.log(`Restored Rollup native binding from ${staging.name}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to rename Rollup staging directory: ${error}`);
  }
}

ensureRollupNativeBinding();
