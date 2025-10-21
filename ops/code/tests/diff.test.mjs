import { extractApplyPatchBlocks, summarizeApplyPatch } from "../lib/diff.mjs";

const patch = `*** Begin Patch
*** Add File: examples/hello.txt
+Hello
*** Update File: uicp/src/lib/foo.ts
@@
- old
+ new
*** End Patch
`;

const blocks = extractApplyPatchBlocks(patch);
if (blocks.length !== 1) throw new Error("expected 1 block");
const sum = summarizeApplyPatch(blocks[0]);
if (!sum.files.includes("examples/hello.txt")) throw new Error("missing examples file");
if (!sum.files.includes("uicp/src/lib/foo.ts")) throw new Error("missing uicp file");

console.log("diff tests passed");

