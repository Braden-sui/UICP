// Policy schema for UICP Security v2
// NOTE: Keep this file framework-agnostic and free of side effects.

export type AllowPrivateLan = 'deny' | 'ask' | 'allow';
export type NetworkMode = 'default_allow' | 'default_deny';
export type RandomMode = 'csprng' | 'prng' | 'deny';

export type QuotaRule = {
  rps?: number; // requests per second burst capacity
  max_response_mb?: number; // hard cap by content-length
};

export type NetworkPolicy = {
  mode: NetworkMode;
  https_only: boolean;
  allow_ip_literals: boolean;
  allow_private_lan: AllowPrivateLan;
  blocklists?: {
    ips?: string[]; // CIDRs or exacts
    domains?: string[]; // wildcards like *.metadata.internal
  };
  wildcard_rules?: Array<{
    allow?: string[]; // domain wildcards e.g. *.github.com
    paths?: string[]; // optional path prefixes
  }>;
  quotas?: {
    domain_defaults?: QuotaRule;
    overrides?: Record<string, QuotaRule>; // by domain wildcard
  };
};

export type ComputePolicy = {
  time: boolean;
  random: RandomMode;
  cpu_ms_per_second?: number;
  mem_mb?: number;
  workers?: 'deny' | 'ask' | 'allow';
  service_worker?: 'deny' | 'ask' | 'allow';
  webrtc?: 'deny' | 'ask' | 'allow';
  webtransport?: 'deny' | 'ask' | 'allow';
};

export type FilesystemScope = {
  description?: string;
  write?: string[];
  read?: string[];
};

export type FilesystemPolicy = {
  access: 'deny' | 'prompt' | 'allow';
  scopes?: FilesystemScope[];
};

export type PermissionsPolicy = {
  persist: boolean;
  review_on_first_run: boolean;
};

export type ObservabilityPolicy = {
  logs?: 'debug' | 'info' | 'warn' | 'error' | 'off';
  policy_overlay?: boolean;
};

const DEFAULT_BLOCKLIST_IPS = ['169.254.169.254/32', '100.100.100.200/32'];
const DEFAULT_BLOCKLIST_DOMAINS = ['*.metadata.internal', '*.metadata.google.internal'];
const DEFAULT_WILDCARD_RULES: NonNullable<NetworkPolicy['wildcard_rules']> = [
  { allow: ['localhost', '127.0.0.1', '*.local', '*.lan'] },
  { allow: ['*.github.com', '*.githubusercontent.com', 'registry.npmjs.org', 'crates.io', 'static.crates.io'] },
];

const cloneScopes = (scopes: FilesystemScope[]): FilesystemScope[] =>
  scopes.map((scope) => ({
    description: scope.description,
    read: scope.read ? [...scope.read] : undefined,
    write: scope.write ? [...scope.write] : undefined,
  }));

const cloneWildcardRules = (
  rules: NonNullable<NetworkPolicy['wildcard_rules']>,
): NonNullable<NetworkPolicy['wildcard_rules']> =>
  rules.map((rule) => ({
    allow: rule.allow ? [...rule.allow] : undefined,
    paths: rule.paths ? [...rule.paths] : undefined,
  }));

const DEFAULT_FILESYSTEM_SCOPES: FilesystemScope[] = [
  {
    description: 'App home',
    read: ['app://home/**'],
    write: ['app://home/**'],
  },
  {
    description: 'Downloads',
    read: ['~/Downloads/**'],
    write: ['~/Downloads/**'],
  },
  {
    description: 'Documents',
    read: ['~/Documents/**'],
    write: ['~/Documents/**'],
  },
];

export type Policy = {
  uicp_policy: 2;
  network: NetworkPolicy;
  compute: ComputePolicy;
  filesystem: FilesystemPolicy;
  permissions: PermissionsPolicy;
  observability?: ObservabilityPolicy;
};

export const ensurePolicy = (p: Partial<Policy>): Policy => {
  // Minimal normalizer to avoid undefined access; not a validator.
  const policy: Policy = {
    uicp_policy: 2,
    network: {
      mode: p.network?.mode ?? 'default_allow',
      https_only: p.network?.https_only ?? false,
      allow_ip_literals: p.network?.allow_ip_literals ?? true,
      allow_private_lan: p.network?.allow_private_lan ?? 'allow',
      blocklists: {
        ips: p.network?.blocklists?.ips ?? [...DEFAULT_BLOCKLIST_IPS],
        domains: p.network?.blocklists?.domains ?? [...DEFAULT_BLOCKLIST_DOMAINS],
      },
      wildcard_rules: p.network?.wildcard_rules
        ? cloneWildcardRules(p.network.wildcard_rules)
        : cloneWildcardRules(DEFAULT_WILDCARD_RULES),
      quotas: {
        domain_defaults: p.network?.quotas?.domain_defaults ?? { rps: 100, max_response_mb: 1024 },
        overrides: p.network?.quotas?.overrides ?? {},
      },
    },
    compute: {
      time: p.compute?.time ?? true,
      random: p.compute?.random ?? 'csprng',
      cpu_ms_per_second: p.compute?.cpu_ms_per_second ?? 2000,
      mem_mb: p.compute?.mem_mb ?? 4096,
      workers: p.compute?.workers ?? 'allow',
      service_worker: p.compute?.service_worker ?? 'allow',
      webrtc: p.compute?.webrtc ?? 'allow',
      webtransport: p.compute?.webtransport ?? 'allow',
    },
    filesystem: {
      access: p.filesystem?.access ?? 'prompt',
      scopes: p.filesystem?.scopes ? cloneScopes(p.filesystem.scopes) : cloneScopes(DEFAULT_FILESYSTEM_SCOPES),
    },
    permissions: {
      persist: p.permissions?.persist ?? true,
      review_on_first_run: p.permissions?.review_on_first_run ?? false,
    },
    observability: {
      logs: p.observability?.logs ?? 'warn',
      policy_overlay: p.observability?.policy_overlay ?? false,
    },
  };
  return policy;
};
