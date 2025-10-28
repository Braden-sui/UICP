import { BaseDirectory, readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import type { Policy } from './policy';

const POLICY_ROOT = 'uicp';
const POLICY_FILENAME = 'policy.json';
const POLICY_PATH = `${POLICY_ROOT}/${POLICY_FILENAME}`;

const ensureDir = async () => {
  try {
    if (await exists(POLICY_ROOT, { baseDir: BaseDirectory.AppData })) return;
    await mkdir(POLICY_ROOT, { baseDir: BaseDirectory.AppData, recursive: true });
  } catch (err) {
    console.warn('[policyPersistence] ensureDir failed', err);
  }
};

export const loadPersistedPolicy = async (): Promise<Policy | null> => {
  try {
    const has = await exists(POLICY_PATH, { baseDir: BaseDirectory.AppData });
    if (!has) return null;
    const txt = await readTextFile(POLICY_PATH, { baseDir: BaseDirectory.AppData });
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object') return obj as Policy;
  } catch (err) {
    if ((import.meta as any)?.env?.DEV) {
      console.debug('[policyPersistence] loadPersistedPolicy failed', err);
    }
  }
  return null;
};

export const persistPolicy = async (p: Policy): Promise<void> => {
  try {
    await ensureDir();
    await writeTextFile(POLICY_PATH, JSON.stringify(p, null, 2), { baseDir: BaseDirectory.AppData });
  } catch (err) {
    console.warn('[policyPersistence] persistPolicy failed', err);
  }
};

