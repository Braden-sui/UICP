// WHY: Typed, structured errors for code ops orchestration.
// INVARIANT: Codes follow E-UICP-#### and messages are ASCII.

const REPO_PREFIX = "UICP"; // Repo prefix for error codes

export function err(codeSuffix, message, data) {
  const code = `E-${REPO_PREFIX}-${String(codeSuffix).padStart(4, "0")}`;
  const e = new Error(`${code} ${message}`);
  e.code = code;
  if (data) e.data = data;
  return e;
}

export function assert(condition, codeSuffix, message, data) {
  if (!condition) throw err(codeSuffix, message, data);
}

export const Errors = {
  ConfigNotFound: 1001,
  ToolMissing: 1002,
  SpawnFailed: 1003,
  PolicyViolation: 1004,
  NetworkViolation: 1005,
  ValidationFailed: 1006,
  ASTParserMissing: 1007,
  CacheMiss: 1008,
  DuplicateEdit: 1009,
  ForbiddenPath: 1010,
  UnsupportedOS: 1011
};

