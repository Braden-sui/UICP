# Harmony Samples (Synthetic)

These are spec-accurate, synthetic Harmony traces for GPT-OSS. They are not recordings from a live model. Use them to bring up your stream parser. Later, replace or augment with real captures to catch provider quirks.

## How to use

Each case has two fenced blocks:

* `harmony name:<case>` contains the raw streamed text (what your socket would yield). Some samples include chunk split markers `<<<CHUNK>>>`. Your test harness should split the string on that marker and feed chunks in order.
* `expected name:<case>` contains the normalized parse result you should produce.

Rules your parser must satisfy:

* Recognize sentinels exactly: `<|start|>`, `<|channel|>`, `<|message|>`, `<|end|>`, `<|return|>`, `<|call|>`, optional `to=...`, optional `<|constrain|>json`.
* Treat `<|return|>` as end of turn. Normalize to `<|end|>` when storing persistent history.
* Preserve message text verbatim. Do not pretty print tool JSON.
* Do not surface `analysis` to users, but keep it in the parsed structure.

---

```harmony name:simple-final
<|start|>assistant<|channel|>final
<|message|>Hello, world.<|return|>
```

```expected name:simple-final
[
  {"role":"assistant","channel":"final","content":"Hello, world."}
]
```

---

```harmony name:tool-call-roundtrip
<|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json
<|message|>{"location":"Denver","format":"celsius"}<|call|>
<|start|>functions.get_weather to=assistant<|channel|>commentary
<|message|>{"sunny":true,"temperature":20}<|end|>
<|start|>assistant<|channel|>final
<|message|>20 C and sunny.<|return|>
```

```expected name:tool-call-roundtrip
[
  {"role":"assistant","channel":"commentary","to":"functions.get_weather","constraint":"json","args":{"location":"Denver","format":"celsius"}},
  {"role":"tool","name":"functions.get_weather","channel":"commentary","content":{"sunny":true,"temperature":20}},
  {"role":"assistant","channel":"final","content":"20 C and sunny."}
]
```

---

```harmony name:multi-channel-one-turn
<|start|>assistant<|channel|>analysis
<|message|>internal<|end|>
<|start|>assistant<|channel|>commentary
<|message|>Planning to call get_weather...<|end|>
<|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json
<|message|>{"location":"SF"}<|call|>
<|start|>functions.get_weather to=assistant<|channel|>commentary
<|message|>{"sunny":true,"temperature":18}<|end|>
<|start|>assistant<|channel|>final
<|message|>18 C and sunny.<|return|>
```

```expected name:multi-channel-one-turn
[
  {"role":"assistant","channel":"analysis","content":"internal"},
  {"role":"assistant","channel":"commentary","content":"Planning to call get_weather..."},
  {"role":"assistant","channel":"commentary","to":"functions.get_weather","constraint":"json","args":{"location":"SF"}},
  {"role":"tool","name":"functions.get_weather","channel":"commentary","content":{"sunny":true,"temperature":18}},
  {"role":"assistant","channel":"final","content":"18 C and sunny."}
]
```

---

```harmony name:chunk-split-sentinels
<<<CHUNK>>><|sta
rt|>assistant<|channel|>final
<<<CHUNK>>><|message|>Hi from split sentinels.<|ret
urn|>
```

```expected name:chunk-split-sentinels
[
  {"role":"assistant","channel":"final","content":"Hi from split sentinels."}
]
```

---

```harmony name:two-tool-calls
<|start|>assistant<|channel|>commentary to=functions.lookup_user <|constrain|>json
<|message|>{"email":"a@example.com"}<|call|>
<|start|>functions.lookup_user to=assistant<|channel|>commentary
<|message|>{"id":"u_123","plan":"pro"}<|end|>
<|start|>assistant<|channel|>commentary to=functions.fetch_usage <|constrain|>json
<|message|>{"user_id":"u_123","range":"2025-10"}<|call|>
<|start|>functions.fetch_usage to=assistant<|channel|>commentary
<|message|>{"tokens":123456,"requests":789}<|end|>
<|start|>assistant<|channel|>final
<|message|>You used 123456 tokens across 789 requests in 2025-10.<|return|>
```

```expected name:two-tool-calls
[
  {"role":"assistant","channel":"commentary","to":"functions.lookup_user","constraint":"json","args":{"email":"a@example.com"}},
  {"role":"tool","name":"functions.lookup_user","channel":"commentary","content":{"id":"u_123","plan":"pro"}},
  {"role":"assistant","channel":"commentary","to":"functions.fetch_usage","constraint":"json","args":{"user_id":"u_123","range":"2025-10"}},
  {"role":"tool","name":"functions.fetch_usage","channel":"commentary","content":{"tokens":123456,"requests":789}},
  {"role":"assistant","channel":"final","content":"You used 123456 tokens across 789 requests in 2025-10."}
]
```

---

```harmony name:malformed-missing-end
<|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json
<|message|>{"location":"NYC"}<|call|>
<|start|>functions.get_weather to=assistant<|channel|>commentary
<|message|>{"sunny":false,"temperature":12}
<|start|>assistant<|channel|>final
<|message|>12 C and cloudy.<|return|>
```

```expected name:malformed-missing-end
{"error":"MissingSentinel","case":"malformed-missing-end"}
```

---

```harmony name:tool-args-pretty-json
<|start|>assistant<|channel|>commentary to=functions.create_invoice <|constrain|>json
<|message|>{
  "customer_id": "u_123",
  "lines": [
    {"sku": "pro-plan", "qty": 1, "price": 20},
    {"sku": "overage",  "qty": 789, "price": 0.0001}
  ],
  "currency": "USD"
}<|call|>
<|start|>functions.create_invoice to=assistant<|channel|>commentary
<|message|>{"invoice_id":"inv_456","total":20.0789}
<|end|>
<|start|>assistant<|channel|>final
<|message|>Invoice inv_456 created. Total 20.0789 USD.<|return|>
```

```expected name:tool-args-pretty-json
[
  {"role":"assistant","channel":"commentary","to":"functions.create_invoice","constraint":"json","args":{
    "customer_id":"u_123",
    "lines":[{"sku":"pro-plan","qty":1,"price":20},{"sku":"overage","qty":789,"price":0.0001}],
    "currency":"USD"
  }},
  {"role":"tool","name":"functions.create_invoice","channel":"commentary","content":{"invoice_id":"inv_456","total":20.0789}},
  {"role":"assistant","channel":"final","content":"Invoice inv_456 created. Total 20.0789 USD."}
]
```

---

Notes:

* Markers `<<<CHUNK>>>` are only for tests that want to simulate streaming boundaries. Your extractor can split on that token. Do not include the marker in production traces.
* The `analysis` content is placeholder. Do not train on real user chain of thought. Keep it minimal.
* If your provider emits extra whitespace around headers, your parser should accept it. For strict tests, we use the canonical form above.
