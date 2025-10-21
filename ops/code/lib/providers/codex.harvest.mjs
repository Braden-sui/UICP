import fs from "node:fs/promises";
import path from "node:path";

export async function harvestCodexSession({ sinceMs = 0 }) {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const root = path.join(home, ".codex", "sessions");
  const exists = await fs.stat(root).then(()=>true).catch(()=>false);
  if (!exists) return null;
  const years = await fs.readdir(root).catch(()=>[]);
  const candidates = [];
  for (const y of years) {
    const ydir = path.join(root, y);
    const months = await fs.readdir(ydir).catch(()=>[]);
    for (const m of months) {
      const mdir = path.join(ydir, m);
      const days = await fs.readdir(mdir).catch(()=>[]);
      for (const d of days) {
        const ddir = path.join(mdir, d);
        const files = await fs.readdir(ddir).catch(()=>[]);
        for (const f of files) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          const full = path.join(ddir, f);
          const st = await fs.stat(full).catch(()=>null);
          if (st && st.mtimeMs >= sinceMs) candidates.push({ file: full, mtime: st.mtimeMs });
        }
      }
    }
  }
  candidates.sort((a,b)=>b.mtime-a.mtime);
  const head = candidates[0];
  if (!head) return null;
  const text = await fs.readFile(head.file, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  return { file: head.file, lines: lines.slice(-200) };
}

