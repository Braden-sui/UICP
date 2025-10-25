# Typing Rationale for Security Module

## Why `any` Types in networkGuard.ts

The `networkGuard.ts` file intentionally uses `any` types for browser API interception. This is a deliberate architectural choice, not a shortcut.

### The Problem

The network guard wraps dynamic global objects that don't have stable type definitions across all environments:

- **XMLHttpRequest**: Prototype manipulation requires accessing dynamic properties
- **WebSocket, EventSource**: Constructor wrapping with runtime property injection
- **RTCPeerConnection**: Configuration object structure varies by browser
- **Worker, SharedWorker**: Constructor arguments are variadic and context-dependent
- **navigator.sendBeacon**: Accepts multiple body types (Blob, ArrayBuffer, string, FormData)

### Why Strict Typing Breaks This

Strict TypeScript typing would require:
1. Declaring all possible property combinations upfront
2. Enumerating every valid configuration shape
3. Handling browser-specific variations in type definitions

This is impossible because:
- Browser APIs evolve and vary by version
- The guard must work in Node.js test environments where DOM types don't exist
- Wrapping requires accessing properties that don't exist on the original type

### The Solution

We use `any` in a controlled, documented way:

1. **File-level disable** - `/* eslint-disable @typescript-eslint/no-explicit-any */` at the top
2. **Comprehensive comment** - Explains the necessity and scope
3. **Narrow scope** - Only in `networkGuard.ts`, not throughout the codebase
4. **Type safety where it matters** - The guard logic itself uses proper types; only the browser API boundaries use `any`

### Example: XMLHttpRequest Wrapping

```typescript
const wrapped = function (this: any, ...args: any[]) {
  // The function signature is 'any' because XMLHttpRequest.open() accepts:
  // - method: string
  // - url: string
  // - async?: boolean
  // - user?: string
  // - password?: string
  // But we only care about the first two for security checks.
  // Strict typing would require a union of all valid call signatures.
  
  const url = args[1] as string;
  const u = toUrl(url);
  // ... security logic uses proper types
};
```

## DOM Types Not Recognized by ESLint

Files that reference standard DOM types (RequestInfo, RequestInit, EventSourceInit, BodyInit, RTCConfiguration) have `no-undef` disabled because ESLint's configuration doesn't include these types despite them being standard browser APIs.

These are disabled at the point of use with `// eslint-disable-next-line no-undef` comments, not file-wide.

## Validation

- ✅ Security logic is type-safe
- ✅ Browser API boundaries are documented
- ✅ No silent errors (all disables are explicit and justified)
- ✅ Follows AGENTS.MD principle: "Be liberal in verification, conservative in speculation"
