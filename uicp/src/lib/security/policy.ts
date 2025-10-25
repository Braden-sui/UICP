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
      https_only: p.network?.https_only ?? true,
      allow_ip_literals: p.network?.allow_ip_literals ?? false,
      allow_private_lan: p.network?.allow_private_lan ?? 'ask',
      blocklists: {
        ips: p.network?.blocklists?.ips ?? [],
        domains: p.network?.blocklists?.domains ?? [],
      },
      wildcard_rules: p.network?.wildcard_rules ?? [],
      quotas: {
        domain_defaults: p.network?.quotas?.domain_defaults ?? {},
        overrides: p.network?.quotas?.overrides ?? {},
      },
    },
    compute: {
      time: p.compute?.time ?? true,
      random: p.compute?.random ?? 'csprng',
      cpu_ms_per_second: p.compute?.cpu_ms_per_second ?? 800,
      mem_mb: p.compute?.mem_mb ?? 256,
      workers: p.compute?.workers ?? 'ask',
      service_worker: p.compute?.service_worker ?? 'ask',
      webrtc: p.compute?.webrtc ?? 'ask',
      webtransport: p.compute?.webtransport ?? 'ask',
    },
    filesystem: {
      access: p.filesystem?.access ?? 'prompt',
      scopes: p.filesystem?.scopes ?? [],
    },
    permissions: {
      persist: p.permissions?.persist ?? true,
      review_on_first_run: p.permissions?.review_on_first_run ?? true,
    },
    observability: {
      logs: p.observability?.logs ?? 'info',
      policy_overlay: p.observability?.policy_overlay ?? true,
    },
  };
  return policy;
};
