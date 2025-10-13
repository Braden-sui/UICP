type EnvKey = keyof ImportMetaEnv & string;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export type ReadNumberOptions = {
  readonly min?: number;
  readonly max?: number;
};

export const readStringEnv = (key: EnvKey, fallback?: string): string | undefined => {
  const raw = import.meta.env[key];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (typeof raw === 'boolean') {
    return raw ? 'true' : 'false';
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : fallback;
  }
  return fallback;
};

export const readBooleanEnv = (key: EnvKey, fallback = false): boolean => {
  const raw = import.meta.env[key];
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
  }
  return fallback;
};

export const readNumberEnv = (key: EnvKey, fallback: number, options?: ReadNumberOptions): number => {
  const raw = import.meta.env[key];
  let value: number | undefined;
  if (typeof raw === 'number') {
    value = Number.isFinite(raw) ? raw : undefined;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  } else if (typeof raw === 'boolean') {
    value = raw ? 1 : 0;
  }

  if (value === undefined) {
    return fallback;
  }

  if (options?.min !== undefined && value < options.min) {
    return fallback;
  }

  if (options?.max !== undefined && value > options.max) {
    return options.max;
  }

  return value;
};
