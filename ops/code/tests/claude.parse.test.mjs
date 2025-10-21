import { parseStreamJson, extractPatchesFromEvents } from "../lib/providers/claude.parse.mjs";

const sample = `{"type":"message_start","id":"1"}\n{"type":"message_delta","text":"*** Begin Patch\\n*** Add File: foo.txt\\n+hi\\n*** End Patch\\n"}\n{"type":"message_end"}`;

const evts = parseStreamJson(sample);
if (evts.length !== 3) throw new Error("expected 3 events");
const blocks = extractPatchesFromEvents(evts);
if (blocks.length !== 1) throw new Error("expected 1 patch block");

console.log("claude.parse tests passed");
