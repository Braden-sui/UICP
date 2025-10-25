/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE: string;
  readonly VITE_UICP_MODE?: string; // 'dev' | 'test' | 'pilot' | 'prod'
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly [key: string]: string | boolean | undefined;
  readonly FOLLOWUP_MAX_DEFAULT?: string;
  readonly FOLLOWUP_MAX_HARD?: string;
  readonly ACTOR_BATCH_DEFAULT?: string;
  readonly ACTOR_BATCH_HARD?: string;
  readonly APP_WALLCLOCK_MS?: string;
  readonly APP_MEM_MB?: string;
  readonly VITE_WIL_ONLY?: string;
  readonly VITE_WIL_DEBUG?: string;
  readonly VITE_WIL_MAX_BUFFER_KB?: string;
  readonly VITE_PLANNER_TIMEOUT_MS?: string;
  readonly VITE_ACTOR_TIMEOUT_MS?: string;
  readonly VITE_CHAT_DEFAULT_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
