// WHY: Map policy command allowlist to Claude CLI tool schema.
export function buildClaudeAllowedTools(commands = []) {
  const result = new Set(["Read", "Edit"]);
  for (const raw of commands ?? []) {
    if (raw == null) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower === "read") {
      result.add("Read");
      continue;
    }
    if (lower === "edit" || lower === "write") {
      result.add("Edit");
      continue;
    }
    const normalized = trimmed.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    if (/^bash\(/i.test(normalized)) {
      result.add(normalized.replace(/^bash/i, "Bash"));
      continue;
    }
    const pattern = normalized.includes(":") ? normalized : `${normalized}:*`;
    result.add(`Bash(${pattern})`);
  }
  return Array.from(result);
}
