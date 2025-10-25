import { spawnp } from "./utils.mjs";
import { err, Errors } from "./errors.mjs";

export function extractApplyPatchBlocks(text) {
  const blocks = [];
  const re = /(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch)/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

export function summarizeApplyPatch(patchText) {
  const files = [];
  const lines = patchText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^\*\*\*\s+(Add File|Update File|Delete File):\s+(.+)$/);
    if (m) {
      const kind = m[1];
      let path = m[2].trim();
      // Look ahead for moves on Update
      if (kind === "Update File") {
        const next = lines[i + 1] || "";
        const mv = next.match(/^\*\*\* Move to: (.+)$/);
        if (mv) path = mv[1].trim();
      }
      files.push(path);
    }
  }
  return { files };
}

export async function applyWithGit(patchText, { checkOnly = false } = {}) {
  // First, sanity check
  const pre = await spawnp("git", ["apply", "--check", "-"], { input: patchText });
  if (pre.code !== 0) throw err(Errors.ValidationFailed, "git apply --check failed", { stderr: pre.stderr });
  if (checkOnly) return { ok: true, checked: true };
  const res = await spawnp("git", ["apply", "-"], { input: patchText });
  if (res.code !== 0) throw err(Errors.SpawnFailed, "git apply failed", { stderr: res.stderr });
  return { ok: true };
}

