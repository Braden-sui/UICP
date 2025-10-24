import { ensurePolicy } from './policy';
import type { Policy } from './policy';

export const PresetOpen: Policy = ensurePolicy({
  network: {
    mode: 'default_allow',
    https_only: true,
    allow_ip_literals: true,
    allow_private_lan: 'allow',
    blocklists: {
      ips: ['169.254.169.254/32', '127.0.0.0/8'],
      domains: ['*.metadata.internal', '*.onion'],
    },
    wildcard_rules: [],
    quotas: {
      domain_defaults: { rps: 50, max_response_mb: 500 },
      overrides: {},
    },
  },
  compute: {
    time: true,
    random: 'csprng',
    cpu_ms_per_second: 1000,
    mem_mb: 512,
    workers: 'allow',
    service_worker: 'allow',
    webrtc: 'allow',
    webtransport: 'allow',
  },
  filesystem: {
    access: 'prompt',
    scopes: [],
  },
  permissions: {
    persist: true,
    review_on_first_run: true,
  },
  observability: {
    logs: 'info',
    policy_overlay: true,
  },
});

export const PresetBalanced: Policy = ensurePolicy({
  network: {
    mode: 'default_allow',
    https_only: true,
    allow_ip_literals: false,
    allow_private_lan: 'ask',
    blocklists: {
      ips: ['169.254.169.254/32', '127.0.0.0/8'],
      domains: ['*.metadata.internal', '*.onion'],
    },
    wildcard_rules: [
      { allow: ['*.github.com', '*.githubusercontent.com'] },
    ],
    quotas: {
      domain_defaults: { rps: 10, max_response_mb: 20 },
      overrides: {
        '*.github.com': { rps: 30, max_response_mb: 200 },
      },
    },
  },
  compute: {
    time: true,
    random: 'csprng',
    cpu_ms_per_second: 800,
    mem_mb: 256,
    workers: 'ask',
    service_worker: 'ask',
    webrtc: 'ask',
    webtransport: 'ask',
  },
  filesystem: {
    access: 'prompt',
    scopes: [],
  },
  permissions: {
    persist: true,
    review_on_first_run: true,
  },
  observability: {
    logs: 'info',
    policy_overlay: true,
  },
});

export const PresetLockedDown: Policy = ensurePolicy({
  network: {
    mode: 'default_deny',
    https_only: true,
    allow_ip_literals: false,
    allow_private_lan: 'deny',
    blocklists: {
      ips: ['169.254.169.254/32', '127.0.0.0/8'],
      domains: ['*.metadata.internal', '*.onion'],
    },
    wildcard_rules: [],
    quotas: {
      domain_defaults: { rps: 5, max_response_mb: 5 },
      overrides: {},
    },
  },
  compute: {
    time: false,
    random: 'deny',
    cpu_ms_per_second: 400,
    mem_mb: 128,
    workers: 'deny',
    service_worker: 'deny',
    webrtc: 'deny',
    webtransport: 'deny',
  },
  filesystem: {
    access: 'deny',
    scopes: [],
  },
  permissions: {
    persist: true,
    review_on_first_run: true,
  },
  observability: {
    logs: 'info',
    policy_overlay: true,
  },
});

export const Presets = {
  open: PresetOpen,
  balanced: PresetBalanced,
  locked: PresetLockedDown,
};
