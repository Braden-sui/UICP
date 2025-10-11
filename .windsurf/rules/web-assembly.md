---
trigger: glob
globs: .wit
---

High-level principles

Contract first, code second
Describe capabilities in WIT, then implement. Packages and worlds are the source of truth for what an agent may import or export. Keep versions in the WIT header. 
component-model.bytecodealliance.org

Capability-based, least privilege, deny by default
Agents get zero ambient authority. Grant only explicit clocks, files, sockets, http, random, logging. Preopen directories instead of letting agents roam the FS. 
Wasmtime
+1

Determinism by design
Assume nondeterminism from time, random, host functions, and NaN payloads. Fence it with fuel or epochs and strict interfaces. Canonicalize float behavior where needed. 
Wasmtime
+2
Wasmtime
+2

Stable WASI 0.2 surface, pin versions
Use WASI 0.2 worlds and pin @x.y.z in imports. Treat WASIp3 and new async features as gated experiments. 
Bytecode Alliance
+1

Composable, portable, auditable
Package as Components, compose with tools, and sign artifacts. Prefer registries that keep provenance. 
component-model.bytecodealliance.org
+2
GitHub
+2

Specific rules for agents in Wasm components
A) WIT, packages, worlds

File starts with a package header and semicolon:
package org:thing@1.2.3;
Use ASCII kebab-case for identifiers. Worlds import interfaces with import pkg/name@version;. Keep types inside interfaces. 
component-model.bytecodealliance.org

Layout for Rust with cargo-component:
put WIT under wit/, set world and path in Cargo.toml, and declare external WIT under [package.metadata.component.target.dependencies]. Paths for deps are resolved relative to your wit dir. Also, explicitly version packages to avoid resolver edge cases. 
component-model.bytecodealliance.org

Compose components when you want a single self-contained artifact, do not “link” by code-level deps. Use wasm-tools component compose. 
component-model.bytecodealliance.org
+1

B) Capabilities and I/O

Filesystem
Only via preopened roots. Never accept absolute host paths from the agent. On Wasmtime CLI this is --dir=...; in embeddings, wire preopens explicitly. 
CoCalc

Streams and polling
Model long operations with wasi:io/streams and wasi:io/poll. Create pollables for readiness and multiplex with a poll call. Do not busy-loop. 
Docs.rs
+1

Clocks
Use wasi:clocks/monotonic-clock for elapsed time and wasi:clocks/wall-clock only when wall time is truly required. Plumb timeouts by mixing a clock pollable into your poll list. 
Wa.dev

Randomness
Use wasi:random interfaces. If you need determinism, replace with a host-seeded deterministic stream or gate it behind a capability switch. Never roll your own crypto inside the guest. 
GitHub

Networking
Prefer wasi:http for HTTP and wasi:sockets for raw TCP/UDP where the runtime supports it. Do not vendor libc sockets and hope. Support is improving but not universal, so feature-gate. 
Wa.dev
+2
GitHub
+2

Logging and observability
Export wasi:logging when available. Otherwise write to STDERR; hosts can capture it. Include correlation fields in every log line. For Wasmtime, WASMTIME_LOG=wasmtime_wasi=trace surfaces syscalls during debug. 
GitHub
+2
wasmCloud
+2

C) Determinism, timeouts, cancellation

Deterministic mode
Disable or gate wall clock and random. Enable NaN canonicalization or avoid using NaN payloads as data. Avoid relaxed-SIMD nondeterministic lanes if bit-for-bit determinism is a requirement. 
Wasmtime
+2
GitHub
+2

Deadlines and cancellation
Use epoch interruption for low overhead global timeouts; use fuel for fine-grained deterministic stepping. Be aware that epoch checks happen at function boundaries and loop headers; a long host import may defer the trap until return. Make cancellation observable in your own interfaces. 
Wasmtime
+1

Async style
In P2, treat long work as chunked units and yield via polls, not blocking sleeps. If you need “wait,” express it as waiting on a pollable. 
wasmCloud

D) Resource limits and multi-tenancy

Per-store limits
Set memory, tables, and instance caps via Store::limiter or StoreLimits. Enforce growth policies; treat grow failures as normal errors. 
Wasmtime
+1

Pooling allocator
Use Wasmtime’s pooling allocator with explicit limits for instances, memories, and tables if you host many agents. Measure, because pool sizing directly allocates address space. 
Wasmtime

CPU control
Choose epochs for cheap coarse timeouts; choose fuel for deterministic instruction budgeting. Both can coexist. 
Docs.rs

E) Networking and HTTP patterns

Outbound HTTP
Import wasi:http/outgoing-handler or use a proxy world; do not embed native TLS stacks in the guest. Treat backpressure and response body streaming with output-stream and pollables. 
Wa.dev

Inbound HTTP
If the agent is an HTTP handler, export wasi:http/incoming-handler and keep request bodies stream-based; never slurp unbounded payloads. 
Wa.dev

Runtime variance
Some runtimes wire sockets directly, others prefer http-only. Feature-detect and degrade gracefully. 
WasmEdge

F) Concurrency, threads, memory64, and proposals

Threads
Do not assume threads exist. The core threads proposal and wasi-threads are still maturing across hosts. If you must, gate it and document the host matrix. 
Bytecode Alliance
+1

memory64
Enable only when truly needed and confirm end-to-end support. It changes pointer sizes and can expose rough edges in toolchains. 
Bytecode Alliance
+1

Keep to stable proposal sets unless you own the host and can carry flags. Check your host’s feature tier pages before flipping switches. 
Wasmtime
+1

G) Packaging, distribution, and supply chain

Cargo manifest rules (Rust)
In Cargo.toml, set [package.metadata.component] package = "ns:name", put WIT under path = "wit" with world = "...", and list external WIT in [package.metadata.component.target.dependencies] with directory paths. Versioning lives in WIT, not the manifest. 
component-model.bytecodealliance.org

Composition and registries
Use wasm-tools to compose, inspect, and print WIT from artifacts. Distribute via OCI or Warg. Sign OCI artifacts with Sigstore cosign. Keep digests in your release notes. 
GitHub
+2
GitHub
+2

Code caching and AOT
Turn on Wasmtime code cache for faster cold starts or precompile where appropriate. 
Wasmtime
+1

H) Agent API design in WIT

Use result<T,E> everywhere. Define a small, numeric error enum and include a human message for logs. WIT result maps nicely to idiomatic Result types. 
component-model.bytecodealliance.org

Stream large outputs as own output-stream and require the client to read; do not return list<u8> for unbounded payloads. Pair with pollable. 
wasmCloud

Always import timeouts via monotonic-clock and accept a deadline-ns: u64 or budget-ms: u32 in your function shapes. You can implement host-side cancellation with epochs, but the contract should make time explicit. 
Wa.dev
+1

Versioning
Put @x.y.z on every package in WIT and bump minor for additive changes. Keep breaking changes behind new packages. The official guides show explicit versions to avoid resolver gotchas. 
component-model.bytecodealliance.org

I) Observability and debugging

Prefer wasi:logging or STDERR for logs, keep them structured and bounded. Scrub secrets. Hosts can route these to their sinks. 
GitHub
+1

Inspect artifacts with wasm-tools component wit <file.wasm> to sanity check worlds, imports, and versions. Use CLI logging in Wasmtime during dev. 
GitHub
+1

J) Language toolchains

Rust: cargo-component for P2, bindings auto-generated, and explicit WIT packages in wit/. 
component-model.bytecodealliance.org

Go: TinyGo 0.34+ has native Component Model + WASI 0.2 support; for wasmCloud, follow their language guidance. 
component-model.bytecodealliance.org
+1

JS/TS: jco for component interop in Node or edge runtimes. 
npm

Python: componentize-py can target WIT worlds, but expect size tradeoffs and early-stage tooling. 
Fermyon

ML: wasi-nn exists but is experimental; inference only, host-backed accelerators vary by runtime. Gate it. 
GitHub
+1

“Do not do this” wall

Do not rely on ambient FS, net, or env. Everything must come from imports or preopens. 
Wasmtime

Do not block. Use pollables, not sleeps. 
wasmCloud

Do not hide nondeterminism. If you use wall time or random, make it a capability and document its effect on replayability. 
Wa.dev
+1

Do not assume threads or memory64. Feature-gate and test the host matrix. 
Bytecode Alliance
+1

Do not return unbounded blobs. Stream and enforce limits. 
wasmCloud

Do not ship unsigned artifacts. Push to OCI or Warg and sign with cosign. 
GitHub
+1

Minimal reference shapes (WIT)

HTTP client agent, streaming response with deadline:

package org:http-client@1.0.0;

world client {
  import wasi:clocks/monotonic-clock@0.2.0;
  import wasi:http/outgoing-handler@0.2.0;

  export http: interface {
    request: func(
      method: string,
      url: string,
      headers: list<string>,
      body: option<list<u8>>,
      deadline-ns: u64
    ) -> result<own wasi:http/types/response-outparam, http-error>;
  }
}


I/O agent with log and backpressure:

package org:io-task@1.0.0;

interface task {
  use wasi:io/streams@0.2.0.{output-stream};
  run: func(job: string, bytes: list<u8>) -> result<own output-stream, task-error>;
}
world entry { export task; }


Both enforce explicit capabilities, deadlines, and streaming. 
Wa.dev
+1

Host checklist to enforce these rules

Wasmtime config: enable epoch interruption or fuel, set store limits, consider pooling allocator, and enable code cache. Document exact settings with your agent SLOs. 
Wasmtime
+3
Docs.rs
+3
Wasmtime
+3

Wire preopens, clocks, random, http, sockets explicitly. No extras. 
CoCalc
+1

Validate and sign artifacts, publish to OCI or Warg. Verify on pull. 
GitHub
+1

Use wasm-tools component wit in CI to assert world, imports, and versions are exactly as expected. 
GitHub

If you want, I can turn this into a WIT + Rust template repo that bakes in epoch timeouts, store limits, logging, and a sample http client world wired the “right” way.