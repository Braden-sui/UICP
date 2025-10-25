import { ensurePolicy } from './policy';
import type { Policy } from './policy';

export const PresetOpen: Policy = ensurePolicy({
  network: {
    mode: 'default_allow',
    https_only: false,
    allow_ip_literals: true,
    allow_private_lan: 'allow',
    blocklists: {
      ips: ['169.254.169.254/32', '100.100.100.200/32'],
      domains: ['*.metadata.internal', '*.metadata.google.internal'],
    },
    wildcard_rules: [
      { allow: ['localhost', '127.0.0.1', '*.local', '*.lan'] },
      { allow: ['*.github.com', '*.githubusercontent.com', 'registry.npmjs.org', 'crates.io', 'static.crates.io'] },
    ],
    quotas: {
      domain_defaults: { rps: 200, max_response_mb: 2048 },
      overrides: {},
    },
  },
  compute: {
    time: true,
    random: 'csprng',
    cpu_ms_per_second: 4000,
    mem_mb: 8192,
    workers: 'allow',
    service_worker: 'allow',
    webrtc: 'allow',
    webtransport: 'allow',
  },
  filesystem: {
    access: 'prompt',
    scopes: [
      { description: 'App home', read: ['app://home/**'], write: ['app://home/**'] },
      { description: 'Downloads', read: ['~/Downloads/**'], write: ['~/Downloads/**'] },
      { description: 'Documents', read: ['~/Documents/**'], write: ['~/Documents/**'] },
      { description: 'Pictures', read: ['~/Pictures/**'], write: ['~/Pictures/**'] },
    ],
  },
  permissions: {
    persist: true,
    review_on_first_run: false,
  },
  observability: {
    logs: 'warn',
    policy_overlay: false,
  },
});

export const PresetBalanced: Policy = ensurePolicy({
  network: {
    mode: 'default_allow',
    https_only: true,
    allow_ip_literals: true,
    allow_private_lan: 'ask',
    blocklists: {
      ips: ['169.254.169.254/32', '100.100.100.200/32'],
      domains: ['*.metadata.internal', '*.metadata.google.internal'],
    },
    wildcard_rules: [
      { allow: ['localhost', '127.0.0.1'] },
      { allow: ['*.github.com', '*.githubusercontent.com'] },
    ],
    quotas: {
      domain_defaults: { rps: 60, max_response_mb: 512 },
      overrides: {
        '*.github.com': { rps: 100, max_response_mb: 1024 },
      },
    },
  },
  compute: {
    time: true,
    random: 'csprng',
    cpu_ms_per_second: 1500,
    mem_mb: 4096,
    workers: 'allow',
    service_worker: 'ask',
    webrtc: 'ask',
    webtransport: 'ask',
  },
  filesystem: {
    access: 'prompt',
    scopes: [
      { description: 'App home', read: ['app://home/**'], write: ['app://home/**'] },
      { description: 'Documents', read: ['~/Documents/**'], write: ['~/Documents/**'] },
    ],
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
