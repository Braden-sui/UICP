declare module '@ops/lib/httpjail' {
  export interface HttpJailOptions {
    hosts?: string[];
    methods?: string[];
    blockPost?: boolean;
  }

  export function buildHttpJailArgs(options: {
    policyFile?: string;
    policy_file?: string;
    providerKey?: string;
    provider_key?: string;
    methods?: string[];
    block_post?: boolean;
    blockPost?: boolean;
  }): Promise<{ exe: string; args: string[] }>;

  export function findHttpJail(): Promise<string>;

  export function policyPredicateForProvider(options: {
    policyFile?: string;
    policy_file?: string;
    providerKey?: string;
    provider_key?: string;
    methods?: string[];
    block_post?: boolean;
    blockPost?: boolean;
  }): Promise<string>;

  export function buildHttpJailPredicate(options: HttpJailOptions): string;
}

declare module '@ops/lib/claude-tools' {
  export function buildClaudeAllowedTools(commands?: string[]): string[];
}
