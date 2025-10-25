import assert from "node:assert/strict";
import { buildContainerCmd } from "../lib/container.mjs";

(async () => {
  const providerCfg = {
    container: {
      image: "uicp/test:latest",
      workdir: "/workspace",
    },
  };
  const runtimeInfo = { binary: "docker", label: "docker", version: "test" };
  const { cmd, args } = await buildContainerCmd(providerCfg, {
    name: "test-job",
    memoryMb: 512,
    cpus: 1,
    runtimeInfo,
  });

  // Base checks
  assert.equal(cmd, "docker");
  const joined = args.join(" ");

  // Resource limits
  assert.ok(joined.includes("--memory 512m"), "--memory present");
  assert.ok(joined.includes("--memory-swap 512m"), "--memory-swap present");
  assert.ok(joined.includes("--cpus 1"), "--cpus present");
  assert.ok(joined.includes("--pids-limit 256"), "--pids-limit present");

  // Security hardening
  assert.ok(joined.includes("--read-only"), "--read-only present");
  assert.ok(joined.includes("--cap-drop ALL"), "--cap-drop ALL present");
  assert.ok(joined.includes("--security-opt no-new-privileges"), "no-new-privileges present");

  // Minimal caps for firewall
  assert.ok(joined.includes("--cap-add NET_ADMIN"), "NET_ADMIN present");
  assert.ok(joined.includes("--cap-add NET_RAW"), "NET_RAW present");

  // Tmpfs mounts
  assert.ok(joined.includes("--tmpfs /tmp:rw"), "/tmp tmpfs present");
  assert.ok(joined.includes("--tmpfs /var/tmp:rw"), "/var/tmp tmpfs present");
  assert.ok(joined.includes("--tmpfs /run:rw"), "/run tmpfs present");
  assert.ok(joined.includes("--tmpfs /home/app:rw"), "/home/app tmpfs present");

  console.log("container.cmd tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
