#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Resolver } from "node:dns";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname);
const linuxDir = path.join(root, "linux");
const nftSetsPath = path.join(linuxDir, "nft-sets.nft");
const macDir = path.join(root, "macos");
const pfDir = path.join(macDir, "tables");
const pfPaths = {
  allow_dns: path.join(pfDir, "allow_dns.txt"),
  allow_job: path.join(pfDir, "allow_job.txt"),
  block_doh: path.join(pfDir, "block_doh.txt"),
  block_priv_v4: path.join(pfDir, "block_priv_v4.txt"),
  block_priv_v6: path.join(pfDir, "block_priv_v6.txt"),
  block_meta_v4: path.join(pfDir, "block_meta_v4.txt"),
  block_meta_v6: path.join(pfDir, "block_meta_v6.txt"),
};

// Seeds (baseline)
const seedsJob = [
  // Git
  "github.com","api.github.com","uploads.github.com","raw.githubusercontent.com","objects.githubusercontent.com","pkg-containers.githubusercontent.com",
  "gitlab.com","gitlab.io","registry.gitlab.com",
  // NPM/Node registries
  "registry.npmjs.org","registry.yarnpkg.com",
  // Artifacts
  "s3.amazonaws.com","storage.googleapis.com",
  // Auth / IdP
  "accounts.google.com","oauth2.googleapis.com","login.microsoftonline.com","sts.windows.net",
  // Telemetry (optional; kept for completeness)
  "api.segment.io","events.growthbook.io"
];

const dohBlockV4 = [
  "1.1.1.1","1.0.0.1","8.8.8.8","8.8.4.4","9.9.9.9","149.112.112.112",
  // NextDNS ranges
  "76.76.2.0/24","76.76.10.0/24"
];

// Baselines for macOS pf tables (also applicable generally)
const blockPrivV4Baseline = [
  "10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","100.64.0.0/10","169.254.0.0/16"
];
const blockPrivV6Baseline = ["fc00::/7","fe80::/10"];
const blockMetaV4Baseline = ["169.254.169.254/32","169.254.170.2/32"];
const blockMetaV6Baseline = ["fd00:ec2::254/128"]; // AWS IMDSv2 IPv6

function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }

async function resolveAll(domains) {
  const r = new Resolver();
  const v4 = new Set();
  const v6 = new Set();
  for (const d of uniq(domains)) {
    try {
      const a = await r.resolve4(d);
      for (const ip of a) v4.add(ip);
    } catch {}
    try {
      const aaaa = await r.resolve6(d);
      for (const ip of aaaa) v6.add(ip);
    } catch {}
    try {
      const cnames = await r.resolveCname(d);
      for (const c of cnames) {
        try { (await r.resolve4(c)).forEach(ip => v4.add(ip)); } catch {}
        try { (await r.resolve6(c)).forEach(ip => v6.add(ip)); } catch {}
      }
    } catch {}
  }
  return { v4: Array.from(v4), v6: Array.from(v6) };
}

function splitIPs(ips) {
  const v4 = []; const v6 = [];
  for (const ip of uniq(ips)) {
    if (ip.includes(":")) v6.push(ip); else v4.push(ip);
  }
  return { v4, v6 };
}

function discoverResolvers() {
  // Prefer system DNS configuration
  try {
    const r = new Resolver();
    const servers = r.getServers();
    return splitIPs(servers);
  } catch {
    return { v4: [], v6: [] };
  }
}

function nfSet(name, elements) {
  const list = uniq(elements);
  if (!list.length) return `flush set inet uicp ${name}`;
  const vals = list.join(", ");
  return `flush set inet uicp ${name}\nadd element inet uicp ${name} { ${vals} }`;
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

async function writeLines(filePath, lines) {
  const content = uniq(lines).join("\n") + (lines.length ? "\n" : "");
  await writeFileAtomic(filePath, content);
}

async function main() {
  const resolvers = discoverResolvers();
  const jobIPs = await resolveAll(seedsJob);

  // DoH v4 list may include CIDRs; pass through as-is
  const dohV4 = dohBlockV4;
  const dohV6 = [];

  const lines = [
    nfSet("allow_dns_v4", resolvers.v4),
    nfSet("allow_dns_v6", resolvers.v6),
    nfSet("allow_job_hosts_v4", jobIPs.v4),
    nfSet("allow_job_hosts_v6", jobIPs.v6),
    nfSet("block_doh_v4", dohV4),
    nfSet("block_doh_v6", dohV6)
  ].join("\n\n");

  await writeFileAtomic(nftSetsPath, `${lines}\n`);
  process.stdout.write(`[uicp-fw] wrote ${path.relative(process.cwd(), nftSetsPath)}\n`);

  // macOS pf tables
  await fs.mkdir(pfDir, { recursive: true });
  await writeLines(pfPaths.allow_dns, [...resolvers.v4, ...resolvers.v6]);
  await writeLines(pfPaths.allow_job, [...jobIPs.v4, ...jobIPs.v6]);
  await writeLines(pfPaths.block_doh, [...dohV4, ...dohV6]);
  await writeLines(pfPaths.block_priv_v4, blockPrivV4Baseline);
  await writeLines(pfPaths.block_priv_v6, blockPrivV6Baseline);
  await writeLines(pfPaths.block_meta_v4, blockMetaV4Baseline);
  await writeLines(pfPaths.block_meta_v6, blockMetaV6Baseline);
  process.stdout.write(`[uicp-fw] wrote pf tables under ${path.relative(process.cwd(), pfDir)}\n`);

  // Journal state for diagnostics
  const state = {
    timestamp: new Date().toISOString(),
    resolvers: { v4: resolvers.v4, v6: resolvers.v6 },
    counts: {
      job_v4: jobIPs.v4.length,
      job_v6: jobIPs.v6.length,
      doh_v4: dohV4.length,
      doh_v6: dohV6.length,
    },
    outputs: {
      linux_sets: path.relative(process.cwd(), nftSetsPath),
      macos_tables_dir: path.relative(process.cwd(), pfDir),
    },
    last_good: true,
  };
  const statePath = path.join(root, 'uicp-fw-state.json');
  await writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
  process.stdout.write(`[uicp-fw] wrote state ${path.relative(process.cwd(), statePath)}\n`);
}

main().catch((e) => {
  process.stderr.write(`[uicp-fw] update-lists failed: ${e && e.message ? e.message : String(e)}\n`);
  process.exit(1);
});
