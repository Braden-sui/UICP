import { BaseDirectory, writeTextFile } from "@tauri-apps/plugin-fs";
import { emitTelemetryEvent } from "../../telemetry";

export { BaseDirectory };

export type SafeWriteOptions = {
  base?: BaseDirectory;
  devDesktopWrite?: boolean;
  runId?: string;
};

export type SafeWriteResult =
  | { ok: true; bytesWritten: number; path: string }
  | { ok: false; errorCode: "E-UICP-FS-TRAVERSAL" | "E-UICP-FS-PATH-DENIED" | "E-UICP-FS-IO"; message: string };

const DEFAULT_BASE = BaseDirectory.AppData;
type SafeWriteErrorCode = Extract<SafeWriteResult, { ok: false }>["errorCode"];

const sanitizePathForPrompt = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed) {
    return "the requested file";
  }
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) {
    return trimmed;
  }
  const tail = segments.slice(-2).join("/");
  return tail || trimmed;
};

const ensureDesktopConfirmation = async (path: string): Promise<void> => {
  try {
    const mod = await import("@tauri-apps/plugin-dialog");
    const ok = await mod.confirm(
      `Allow the agent to export ${sanitizePathForPrompt(path)} to your Desktop?`,
      { title: "Desktop export" },
    );
    if (!ok) {
      throw new Error("E-UICP-6202: Desktop export denied by user");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("E-UICP-6202")) {
      throw error;
    }
    throw new Error("E-UICP-6201: Desktop export confirmation unavailable");
  }
};

const normalizeRelativePath = (input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return null;
  }
  const pieces = trimmed.replace(/\\/g, "/").split("/");
  const safe: string[] = [];
  for (const piece of pieces) {
    if (!piece || piece === ".") continue;
    if (piece === "..") return null;
    safe.push(piece);
  }
  if (safe.length === 0) return null;
  return safe.join("/");
};

type BinaryWriter = (path: string, data: Uint8Array, options: { baseDir?: BaseDirectory }) => Promise<void>;
let binaryWriter: BinaryWriter | null | undefined;

const ensureBinaryWriter = async (): Promise<BinaryWriter | null> => {
  if (binaryWriter !== undefined) {
    return binaryWriter;
  }
  try {
    const mod = await import("@tauri-apps/plugin-fs");
    const maybe = (mod as Record<string, unknown>).writeBinaryFile;
    binaryWriter = typeof maybe === "function" ? (maybe as BinaryWriter) : null;
  } catch {
    binaryWriter = null;
  }
  return binaryWriter;
};

const logWriteEvent = (runId: string | undefined, path: string, size: number, ok: boolean, errorCode?: SafeWriteErrorCode) => {
  try {
    emitTelemetryEvent("safe_write", {
      traceId: runId ?? `fs:${path}`,
      span: "fs",
      status: ok ? "ok" : "error",
      data: {
        path,
        size,
        ok,
        errorCode,
      },
    });
  } catch {
    // best effort
  }
};

export const safeWrite = async (
  relPath: string,
  data: Uint8Array | string,
  opts: SafeWriteOptions = {},
): Promise<SafeWriteResult> => {
  const normalized = normalizeRelativePath(relPath);
  const runId = opts.runId;
  if (!normalized) {
    const result: SafeWriteResult = {
      ok: false,
      errorCode: "E-UICP-FS-TRAVERSAL",
      message: "Unsafe path rejected",
    };
    logWriteEvent(runId, relPath, 0, false, result.errorCode);
    return result;
  }

  const base = opts.base ?? DEFAULT_BASE;

  if (base === BaseDirectory.Desktop) {
    if (!opts.devDesktopWrite) {
      const result: SafeWriteResult = {
        ok: false,
        errorCode: "E-UICP-FS-PATH-DENIED",
        message: "Desktop writes require explicit devDesktopWrite flag",
      };
      logWriteEvent(runId, normalized, 0, false, result.errorCode);
      return result;
    }
    try {
      await ensureDesktopConfirmation(normalized);
      console.info("desktop export confirmed", { path: normalized });
    } catch (error) {
      console.warn("desktop export denied or unavailable", { path: normalized, error });
      const result: SafeWriteResult = {
        ok: false,
        errorCode: "E-UICP-FS-PATH-DENIED",
        message: error instanceof Error ? error.message : String(error),
      };
      logWriteEvent(runId, normalized, 0, false, result.errorCode);
      return result;
    }
  }

  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const size = bytes.byteLength;

  try {
    if (typeof data === "string") {
      await writeTextFile(normalized, data, { baseDir: base });
    } else {
      const writer = await ensureBinaryWriter();
      if (!writer) {
        throw new Error("binary writer unavailable");
      }
      await writer(normalized, data, { baseDir: base });
    }
    logWriteEvent(runId, normalized, size, true);
    return { ok: true, bytesWritten: size, path: normalized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWriteEvent(runId, normalized, size, false, "E-UICP-FS-IO");
    return { ok: false, errorCode: "E-UICP-FS-IO", message };
  }
};
