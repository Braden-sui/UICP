import assert from "node:assert/strict";
import { parseClaudeStream } from "../lib/providers/claude.parse.mjs";

const sample = [
  "{\"type\":\"message_start\",\"id\":\"1\"}",
  "not json line",
  "{\"type\":\"message_delta\",\"delta\":{\"text\":\"hi\"}}",
  "{\"foo\":\"bar\"}",
  "{\"type\":\"message_end\",\"usage\":{\"input_tokens\":10,\"output_tokens\":20}}",
].join("\n");

const { events, diagnostics } = parseClaudeStream(sample);
assert.equal(diagnostics.lines_total, 5);
assert.equal(diagnostics.lines_non_json, 1);
assert.ok(diagnostics.lines_parsed >= 3);
assert.ok(events.length >= 3);
console.log("claude.parse diagnostics tests passed");
