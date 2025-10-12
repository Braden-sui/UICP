// Minimal typings for @tauri-apps/plugin-dialog used in this app.
// If the real package types are present, these are shadowed.

declare module '@tauri-apps/plugin-dialog' {
  export type Filter = { name?: string; extensions: string[] };

  export function open(options?: {
    multiple?: boolean;
    directory?: boolean;
    filters?: Filter[];
    defaultPath?: string;
    title?: string;
  }): Promise<string | string[] | null>;

  export function save(options?: {
    filters?: Filter[];
    defaultPath?: string;
    title?: string;
  }): Promise<string | null>;

  export function message(message: string, options?: { title?: string }): Promise<void>;
  export function ask(message: string, options?: { title?: string }): Promise<boolean>;
  export function confirm(message: string, options?: { title?: string }): Promise<boolean>;
}

