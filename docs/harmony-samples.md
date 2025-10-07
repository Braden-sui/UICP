# Harmony Streaming Reference

This file tracks raw response fragments for GPT-OSS Harmony integrations. Capture actual chunks whenever we exercise the live models so parser changes can be regression-tested offline.

## Sample Outline (from OpenAI Harmony spec)

{ "choices": [ { "delta": { "channel": "analysis", "content": "Considering window layout options..." } } ] }

> Replace the stub above with recorded chunks from real sessions as soon as we wire up the GPT-OSS profile and hit the API.

## TODO
- [ ] Record planner stream (analysis + commentary + final + tool_call).
- [ ] Record actor stream (commentary batches, final summary).
- [ ] Note any additional event types returned by the Responses API.
