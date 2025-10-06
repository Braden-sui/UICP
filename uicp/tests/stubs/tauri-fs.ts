import type { BaseDirectory as BaseDirectoryEnum } from "@tauri-apps/api/path";
import { BaseDirectory as RealBaseDirectory } from "@tauri-apps/api/path";

// Vitest runs in jsdom and does not load the real Tauri FS plugin.
// Re-export the enum from the path module so code keeps the same contract.
export const BaseDirectory = RealBaseDirectory;

export type BaseDirectory = BaseDirectoryEnum;

type WriteFileOptions = {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  baseDir?: BaseDirectory;
};

export const writeTextFile = async (
  _path: string,
  _contents: string,
  _options?: WriteFileOptions
) => {
  // Tests only assert that we attempt persistence; they do not require IO.
};

export default { writeTextFile, BaseDirectory };
