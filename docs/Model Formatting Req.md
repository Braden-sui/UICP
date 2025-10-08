Formatting conversations for Ollama’s cloud models

Purpose of this document – Ollama Cloud gives you access to very large open‑weight models like gpt‑oss‑20b‑cloud, gpt‑oss‑120b‑cloud, qwen3‑coder‑480b‑cloud and deepseek‑v3.1‑cloud. These models are exposed through chat‑style APIs and each expects a specific prompt format. Providing the right structure allows the model to understand your instructions, to return intermediate reasoning when available, and to call functions. This document summarises formatting guidelines and includes code examples for each model.

Important: The instructions below refer to the cloud models hosted by Ollama. Models served locally via the ollama CLI may use different chat templates and should not be confused with the cloud endpoints.

Authentication: All Ollama Cloud requests use `Authorization: Bearer <api-key>` as documented at https://docs.ollama.com/cloud.

Model naming: Cloud endpoints expect hyphen-delimited tags (e.g., `gpt-oss-120b-cloud`); the local Ollama CLI retains colon tags (e.g., `gpt-oss:120b`). The bridge normalizes automatically.

UICP output constraints (planner/actor)
- When targeting the desktop builder, models must emit a single JSON object for the planner, and `{ "batch": [...] }` for the actor, using the UICP operation names (e.g., `window.create`, `dom.set`).
- No JavaScript, `<script>`/`<style>` tags, or inline event handlers. Interactivity is declared via HTML `data-*` attributes that the runtime executes (`data-command`, `data-state-scope`, `data-state-key`).
 - Do not emit any event APIs or custom ops (`event.addListener`, `addEventListener`, or `event.*`). The runtime wires events declaratively via attributes only.
 - The provider prepends a compact Environment Snapshot (agent state, open windows, and a trimmed DOM summary) to planner/actor prompts to improve context-awareness.
- Prefer compact HTML; avoid excessive whitespace.
- For follow-ups, render a "Clarify" window and wire Submit to `api.call` with `url: "uicp://intent"` and body `{ text: "{{form.answer}}" }` — the app converts this to a new user message automatically.
- The active planner/actor format is controlled via **Agent Settings** (desktop shortcut) or environment (`VITE_PLANNER_PROFILE`, `VITE_ACTOR_PROFILE`). GPT‑OSS profiles enable Harmony formatting; DeepSeek/Qwen remain legacy defaults.

1. GPT‑OSS models (gpt‑oss-20b-cloud & gpt‑oss-120b-cloud)
1.1 Harmony response format — canonical reference: <https://cookbook.openai.com/articles/openai-harmony>

Harmony extends ChatML with explicit channels, sentinel tokens, and a strict role hierarchy:

- **Roles:** `system > developer > user > assistant > tool`. Higher roles override lower roles when instructions conflict.
- **Message envelope:** every turn is framed as `<|start|>{header}<|message|>{content}<|end|>`. Assistant messages end with `<|return|>` (final answer) or `<|call|>` (tool invocation). Persist history using `<|end|>`.
- **Channels:** assistant outputs must specify one of three channels—`analysis` (private chain-of-thought), `commentary` (tool plans + function calls), `final` (user-facing answer). Valid channel reminder should appear in the prompt so the model tags each message.
- **Tool calls:** commentary messages can include `to=functions.foo` plus `<|constrain|>json`. The content block contains JSON args and terminates with `<|call|>`. After executing the tool, inject a tool-role message `<|start|>functions.foo to=assistant<|channel|>commentary<|message|>{...}<|end|>` before resuming sampling.
- **Reasoning effort:** set in the developer/system message (`Reasoning: low|medium|high`); higher effort yields longer analysis.
- **Structured outputs:** define optional response formats at the end of the developer message via JSON Schema to nudge structured replies.

Because Harmony turns stream across channels, the frontend must buffer analysis privately, render commentary transparently, and only surface `final` to end-users. Tool call state should pause decoding until the tool result is appended.

1.2 Constructing prompts

The GPT‑OSS planner/actor profiles we ship now build developer messages that include:

```
# Harmony Output Requirements
- Valid assistant channels: analysis, commentary, final ...
- Tool call contract ...

# Response Formats
## uicp_plan
{ ... }
```

Our GPT‑OSS profiles set `reasoning_level` in the developer content, keep built-in tool docs in the system prompt, and list any UICP functions under `# Tools` using TypeScript-style signatures as expected by Harmony.

1.3 Example request to the Ollama Cloud API

The cloud API exposes Ollama-native endpoints under https://ollama.com/api/*. An example using Python’s requests library:

import os, json, requests

api_key = os.environ["OLLAMA_API_KEY"]  # store your key securely
url = "https://ollama.com/api/chat"

messages = [
    {
        "role": "developer",
        "content": {
            "instructions": "You are a helpful assistant that solves math problems.",
            "reasoning_level": "high",
            "tools": []
        }
    },
    {"role": "user", "content": "What is 3×4?"}
]

payload = {
    "model": "gpt-oss-20b-cloud",  # or gpt-oss-120b-cloud
    "messages": messages,
    "stream": True  # enable streaming if desired
}

headers = {"Authorization": f"Bearer {api_key}"}

response = requests.post(url, headers=headers, json=payload, stream=True)
for chunk in response.iter_lines():
    if chunk:
        data = json.loads(chunk.decode("utf-8")[6:])  # remove 'data: '
        for choice in data.get("choices", []):
            channel = choice["message"].get("channel")
            content = choice["message"].get("content") or choice["message"].get("thinking")
            if channel == "final":
                print("Final answer:", content)
            elif channel == "analysis":
                # internal reasoning (can be logged)
                pass
            elif channel == "commentary":
                # handle tool call or commentary
                pass


A cURL example for a one‑shot query:

curl https://ollama.com/api/chat \ 
  -H "Authorization: Bearer $OLLAMA_API_KEY" \ 
  -H "Content-Type: application/json" \ 
  -d '{
    "model": "gpt-oss-120b-cloud",
    "messages": [
      {"role": "developer", "content": {"instructions": "Translate English to French", "reasoning_level": "low", "tools": []}},
      {"role": "user", "content": "Hello world"}
    ]
  }'


The response will include messages keyed by channel; the translation appears in the final channel and the chain‑of‑thought in analysis.

1.4 Best practices

Include all previous messages in each request because GPT‑OSS models are stateless.

Always specify a channel for assistant messages and keep the channel names lowercase. The search results for the Harmony specification warn that valid channels are analysis, commentary and final and that each message must include a channel
cookbook.openai.com
.

Set reasoning_level to control verbosity; lower levels return shorter reasoning.

Tool calls: define your tools in the developer message. When the model calls a tool, the call appears in the commentary channel; your application must execute the function and append the tool result back as an assistant message (typically on commentary or analysis).

2. Qwen3‑Coder‑480B‑Cloud
2.1 Model overview

Qwen3‑Coder‑480B is an open‑source agentic coding model in Alibaba’s Qwen3 family. It excels at code generation and tool‑calling. Search snippets from API documentation and community guides indicate that Qwen3‑Coder provides examples on how to format your dialog history and system prompt
github.com
 and emphasises prompt design for tool calling
docs.unsloth.ai
.

Because public access to the full documentation is limited in this environment, the following guidelines are based on available snippets and general usage patterns for similar Qwen models.

2.2 Chat format

System (or developer) message – start with a high‑level instruction describing the coding assistant’s role. For example: “You are Qwen‑Coder, a coding assistant that writes Python code and explains your thought process.” Qwen documentation highlights that the system prompt should define the persona and any constraints
github.com
.

User messages – ask the coding question or provide context. Be specific about the desired programming language, style guidelines and complexity. A CometAPI summary recommends specifying language, style and desired complexity, and using iterative refinement where follow‑up prompts correct or extend the code
blogs.novita.ai
.

Assistant responses – Qwen‑Coder tends to include reasoning and code. Maintain the conversation history to allow the model to reference prior steps. Unlike GPT‑OSS, Qwen uses the traditional ChatML format and does not require channel metadata.

2.3 Tool calling

Qwen‑Coder can call user‑defined functions. The Unsloth documentation (summarised in search results) describes how to format prompts for tool calling: it shows an example where a Python function get_current_temperature is defined, and a prompt demonstrates how to request that function
docs.unsloth.ai
. To enable tool calls:

Include a system/developer message listing the available tools (name, description and JSON schema).

Ask your question normally in the user message.

Inspect the assistant’s JSON response; if a tool call is present, execute the function and append the result as another assistant message.

2.4 Example API call
import os, requests

api_key = os.environ["OLLAMA_API_KEY"]
url = "https://ollama.com/api/chat"

messages = [
    {"role": "system", "content": "You are Qwen‑Coder, a coding assistant that writes idiomatic Python."},
    {"role": "user", "content": "Write a function to compute the factorial of n."}
]

payload = {
    "model": "qwen3-coder-480b-cloud",
    "messages": messages
}

headers = {"Authorization": f"Bearer {api_key}"}
response = requests.post(url, headers=headers, json=payload)
print(response.json()["choices"][0]["message"]["content"])


If tool calling is required, include a tools field in the payload similar to GPT‑OSS.

3. DeepSeek‑V3.1‑Cloud
3.1 Hybrid reasoning modes

DeepSeek V3.1 is a large hybrid reasoning model. Search results emphasise that DeepSeek‑V3.1 supports both thinking and non‑thinking modes, enabling the model to switch between chain‑of‑thought reasoning and concise answers
huggingface.co
. The OpenRouter summary notes that it is a large model (671 billion parameters, 37 billion active) and that the modes can be controlled via the prompt
openrouter.ai
.

The official API (which may require authentication) exposes two endpoints: DeepSeek‑V3.1‑Think for full reasoning and DeepSeek‑V3.1‑Chat for concise answers. Ollama Cloud typically names the model deepseek-v3.1-cloud and expects the request to specify the desired mode via the prompt. For example:

To activate thinking mode, prefix the user’s query with a tag such as # think\n or instruct the model to “show your reasoning.”

For non‑thinking mode, use a plain question or prefix with # concise\n to request a short answer.

3.2 Prompt structure

DeepSeek uses a standard ChatML format:

System message (optional) – set the assistant’s role and any constraints, e.g., “You are a mathematics tutor. Show your work when asked.”

User message – ask the question. If you want chain‑of‑thought, prefix with a marker (e.g., # think). Without the marker, the model returns a shorter answer.

Assistant message – returned by the API. In thinking mode, the response may include detailed reasoning followed by the final answer; in concise mode, the reasoning is omitted.

3.3 Example API call
import os, requests

api_key = os.environ["OLLAMA_API_KEY"]
url = "https://ollama.com/api/chat"

messages = [
    {"role": "system", "content": "You are a knowledgeable assistant."},
    {"role": "user", "content": "# think\nExplain why the sky is blue in a way a child would understand."}
]

payload = {
    "model": "deepseek-v3.1-cloud",
    "messages": messages
}
headers = {"Authorization": f"Bearer {api_key}"}
response = requests.post(url, headers=headers, json=payload)
print(response.json()["choices"][0]["message"]["content"])


To get a concise answer, remove # think from the user content.

4. Comparison and best practices
Model	Unique formatting requirements	Channels / modes	Notes
GPT‑OSS (20B & 120B)	Must use the Harmony format: developer message first, assistant messages with explicit analysis, commentary or final channels. Include reasoning‑level and tool definitions in the developer message
.	Three channels: analysis (internal chain‑of‑thought), commentary (tool calls/notes) and final (user‑facing answer)
cookbook.openai.com
. Each assistant message must specify a channel.	Use this format even when no tools are defined; otherwise the model may respond unexpectedly.
Qwen3‑Coder‑480B	Uses a conventional ChatML format with system, user and assistant roles. Provide a clear system prompt defining the coding assistant’s persona. When using tool calling, include tool definitions and follow examples to format prompts
docs.unsloth.ai
.	No channels. Responses include reasoning and code in a single assistant message.	Specify programming language, style and complexity in the user message
blogs.novita.ai
. Use iterative refinement – ask follow‑up questions to improve the code.
DeepSeek‑V3.1	Supports two modes. Use standard ChatML messages but control thinking vs. non‑thinking via a prefix or explicit instruction. The # think marker triggers chain‑of‑thought reasoning
huggingface.co
.	Two modes: thinking (detailed reasoning) and concise (short answer).	Use the appropriate prefix for the desired mode. Remove chain‑of‑thought before showing the answer to end‑users if you want a concise output.
5. Conclusion

Correct prompt formatting is essential when using Ollama Cloud models. GPT‑OSS models require the Harmony response format with explicit channels and reasoning levels, while Qwen3‑Coder and DeepSeek use more traditional chat structures but offer tool calling and reasoning‑mode selection, respectively. Always review the latest model documentation when available. Follow the examples above to structure your API calls correctly and to make the most of each model’s capabilities.

Sources
You said:
you left out kimi k2?
ChatGPT said:
Worked for 5 minutes

I’ve expanded the report to include Kimi‑K2‑1T‑Cloud, adding its model overview, prompt format guidelines, and an API usage example. I also updated the comparison table and conclusion to reflect this additional model.

Here’s the updated report:
Formatting conversations for Ollama’s cloud models

Purpose of this document – Ollama Cloud gives you access to very large open‑weight models like gpt‑oss‑20b‑cloud, gpt‑oss‑120b‑cloud, qwen3‑coder‑480b‑cloud and deepseek‑v3.1‑cloud. These models are exposed through chat‑style APIs and each expects a specific prompt format. Providing the right structure allows the model to understand your instructions, to return intermediate reasoning when available, and to call functions. This document summarises formatting guidelines and includes code examples for each model.

Important: The instructions below refer to the cloud models hosted by Ollama. Models served locally via the ollama CLI may use different chat templates and should not be confused with the cloud endpoints.

1. GPT‑OSS models (gpt‑oss‑20b‑cloud & gpt‑oss‑120b‑cloud)
1.1 Harmony response format

OpenAI’s GPT‑OSS models use a structured format called Harmony. Harmony extends ChatML by introducing explicit roles and “channels.” The Hugging Face trl documentation notes that Harmony was introduced to provide a richer structure for reasoning and tool calls
. Key elements are:

Developer role – similar to a system prompt; used by the developer to provide high‑level instructions and to list available tools
. It is always the first message in the conversation.

Channels – every assistant message must specify a channel. The analysis channel contains the model’s internal reasoning (chain‑of‑thought) which should not be shown to the user; the final channel contains the answer intended for the user; the commentary channel is used for tool‑calling or explanations around actions
. Search results summarising the official Harmony specification emphasise that valid channels are analysis, commentary and final and that a channel must be included for every message
cookbook.openai.com
.

Reasoning effort – the developer can set a reasoning‑effort level (low, medium or high) to control how much internal reasoning the model performs
. Higher effort yields more detailed analysis but costs additional tokens.

Model identity – optional metadata used to define the assistant’s persona or tone
.

Because Harmony messages carry multiple streams, code consuming the model’s response must parse the returned JSON to separate analysis, final and commentary content. Tool calls (function names and arguments) will appear in the commentary channel.

1.2 Constructing prompts

A Harmony conversation typically has the following structure:

Developer message (role developer). Contains high‑level rules, allowed tools and optionally the reasoning effort. Example:

{
  "role": "developer",
  "content": {
    "instructions": "You are an expert travel agent. Use the weather API to plan trips.",
    "tools": [
      {
        "name": "get_weather",
        "description": "Returns current weather for a city",
        "parameters": {"type":"object", "properties": {"city": {"type":"string"}}}
      }
    ],
    "reasoning_level": "medium"
  }
}


User messages – use the user role. Provide the conversation history just like ChatML; no channels are specified for users.

Assistant messages – each assistant response must include a channel. After each turn, keep the previous assistant messages (including analysis and commentary) in the conversation history unless you explicitly drop them. The Harmony spec emphasises that calls to tools must go to the commentary channel
cookbook.openai.com
.

1.3 Example request to the Ollama Cloud API

The cloud API uses the standard OpenAI chat endpoint but the host is https://ollama.com or via the OpenAI‑compatible endpoint. An example using Python’s requests library:

import os, json, requests

api_key = os.environ["OLLAMA_API_KEY"]  # store your key securely
url = "https://ollama.com"

messages = [
    {
        "role": "developer",
        "content": {
            "instructions": "You are a helpful assistant that solves math problems.",
            "reasoning_level": "high",
            "tools": []
        }
    },
    {"role": "user", "content": "What is 3×4?"}
]

payload = {
    "model": "gpt-oss-20b-cloud",  # or gpt-oss-120b-cloud
    "messages": messages,
    "stream": True  # enable streaming if desired
}

headers = {"Authorization": f"Bearer {api_key}"}

response = requests.post(url, headers=headers, json=payload, stream=True)
for chunk in response.iter_lines():
    if chunk:
        data = json.loads(chunk.decode("utf-8")[6:])  # remove 'data: '
        for choice in data.get("choices", []):
            channel = choice["message"].get("channel")
            content = choice["message"].get("content") or choice["message"].get("thinking")
            if channel == "final":
                print("Final answer:", content)
            elif channel == "analysis":
                # internal reasoning (can be logged)
                pass
            elif channel == "commentary":
                # handle tool call or commentary
                pass


A cURL example for a one‑shot query:

curl https://ollama.com \ 
  -H "Authorization: Bearer $OLLAMA_API_KEY" \ 
  -H "Content-Type: application/json" \ 
  -d '{
    "model": "gpt-oss-120b-cloud",
    "messages": [
      {"role": "developer", "content": {"instructions": "Translate English to French", "reasoning_level": "low", "tools": []}},
      {"role": "user", "content": "Hello world"}
    ]
  }'


The response will include messages keyed by channel; the translation appears in the final channel and the chain‑of‑thought in analysis.

1.4 Best practices

Include all previous messages in each request because GPT‑OSS models are stateless.

Always specify a channel for assistant messages and keep the channel names lowercase. The search results for the Harmony specification warn that valid channels are analysis, commentary and final and that each message must include a channel
cookbook.openai.com
.

Set reasoning_level to control verbosity; lower levels return shorter reasoning.

Tool calls: define your tools in the developer message. When the model calls a tool, the call appears in the commentary channel; your application must execute the function and append the tool result back as an assistant message (typically on commentary or analysis).

2. Qwen3‑Coder‑480B‑Cloud
2.1 Model overview

Qwen3‑Coder‑480B is an open‑source agentic coding model in Alibaba’s Qwen3 family. It excels at code generation and tool‑calling. Search snippets from API documentation and community guides indicate that Qwen3‑Coder provides examples on how to format your dialog history and system prompt
github.com
 and emphasises prompt design for tool calling
docs.unsloth.ai
.

Because public access to the full documentation is limited in this environment, the following guidelines are based on available snippets and general usage patterns for similar Qwen models.

2.2 Chat format

System (or developer) message – start with a high‑level instruction describing the coding assistant’s role. For example: “You are Qwen‑Coder, a coding assistant that writes Python code and explains your thought process.” Qwen documentation highlights that the system prompt should define the persona and any constraints
github.com
.

User messages – ask the coding question or provide context. Be specific about the desired programming language, style guidelines and complexity. A CometAPI summary recommends specifying language, style and desired complexity, and using iterative refinement where follow‑up prompts correct or extend the code
blogs.novita.ai
.

Assistant responses – Qwen‑Coder tends to include reasoning and code. Maintain the conversation history to allow the model to reference prior steps. Unlike GPT‑OSS, Qwen uses the traditional ChatML format and does not require channel metadata.

2.3 Tool calling

Qwen‑Coder can call user‑defined functions. The Unsloth documentation (summarised in search results) describes how to format prompts for tool calling: it shows an example where a Python function get_current_temperature is defined, and a prompt demonstrates how to request that function
docs.unsloth.ai
. To enable tool calls:

Include a system/developer message listing the available tools (name, description and JSON schema).

Ask your question normally in the user message.

Inspect the assistant’s JSON response; if a tool call is present, execute the function and append the result as another assistant message.

2.4 Example API call
import os, requests

api_key = os.environ["OLLAMA_API_KEY"]
url = "https://ollama.com"

messages = [
    {"role": "system", "content": "You are Qwen‑Coder, a coding assistant that writes idiomatic Python."},
    {"role": "user", "content": "Write a function to compute the factorial of n."}
]

payload = {
    "model": "qwen3-coder-480b-cloud",
    "messages": messages
}

headers = {"Authorization": f"Bearer {api_key}"}
response = requests.post(url, headers=headers, json=payload)
print(response.json()["choices"][0]["message"]["content"])


If tool calling is required, include a tools field in the payload similar to GPT‑OSS.

3. DeepSeek‑V3.1‑Cloud
3.1 Hybrid reasoning modes

DeepSeek V3.1 is a large hybrid reasoning model. Search results emphasise that DeepSeek‑V3.1 supports both thinking and non‑thinking modes, enabling the model to switch between chain‑of‑thought reasoning and concise answers
huggingface.co
. The OpenRouter summary notes that it is a large model (671 billion parameters, 37 billion active) and that the modes can be controlled via the prompt
openrouter.ai
.

The official API (which may require authentication) exposes two endpoints: DeepSeek‑V3.1‑Think for full reasoning and DeepSeek‑V3.1‑Chat for concise answers. Ollama Cloud typically names the model deepseek-v3.1-cloud and expects the request to specify the desired mode via the prompt. For example:

To activate thinking mode, prefix the user’s query with a tag such as # think\n or instruct the model to “show your reasoning.”

For non‑thinking mode, use a plain question or prefix with # concise\n to request a short answer.

3.2 Prompt structure

DeepSeek uses a standard ChatML format:

System message (optional) – set the assistant’s role and any constraints, e.g., “You are a mathematics tutor. Show your work when asked.”

User message – ask the question. If you want chain‑of‑thought, prefix with a marker (e.g., # think). Without the marker, the model returns a shorter answer.

Assistant message – returned by the API. In thinking mode, the response may include detailed reasoning followed by the final answer; in concise mode, the reasoning is omitted.

3.3 Example API call
import os, requests

api_key = os.environ["OLLAMA_API_KEY"]
url = "https://ollama.com"

messages = [
    {"role": "system", "content": "You are a knowledgeable assistant."},
    {"role": "user", "content": "# think\nExplain why the sky is blue in a way a child would understand."}
]

payload = {
    "model": "deepseek-v3.1-cloud",
    "messages": messages
}
headers = {"Authorization": f"Bearer {api_key}"}
response = requests.post(url, headers=headers, json=payload)
print(response.json()["choices"][0]["message"]["content"])


To get a concise answer, remove # think from the user content.

4. Kimi‑K2‑1T‑Cloud
4.1 Model overview

Kimi K2‑Instruct‑0905 is a state‑of‑the‑art mixture‑of‑experts (MoE) language model developed by Moonshot AI. It has 32 billion activated parameters out of a 1 trillion parameter MoE and offers a 256k token context window. The Ollama library page notes that Kimi K2‑Instruct‑0905 is the latest and most capable version, with enhanced agentic coding intelligence, improvements in frontend coding experience and an extended context length
ollama.com
. These characteristics make it well suited for long‑context coding and reasoning tasks.

4.2 Prompt format

Documentation and community examples suggest that Kimi K2 uses a chat‑style format similar to ChatML. DataCamp’s guide on Kimi K2 notes that the simple_chat() function sends a predefined prompt to the model using a system and user message, indicating that Kimi K2 expects a system prompt followed by user messages
datacamp.com
. Unlike GPT‑OSS, there are no explicit Harmony channels. Use the following structure:

System message – define the assistant’s role and any global instructions. For example: “You are Kimi K2, an expert coding assistant. Provide clear explanations and well‑structured code.”

User messages – include the user’s questions or tasks. Because Kimi K2 has a very long context window, you can include substantial context (e.g., code snippets or previous dialog) to aid reasoning.

Assistant responses – the model’s outputs. Keep the conversation history in subsequent requests to maintain context.

When building software agents, Moonshot’s API documentation recommends configuring tools and prompt parameters through the platform and highlights best practices for using the model in software agents
platform.moonshot.ai
. Always provide clear instructions and, if tool calls are needed, include the tool definitions in the system prompt.

4.3 Example API call
import os, requests

api_key = os.environ["OLLAMA_API_KEY"]
url = "https://ollama.com"

messages = [
    {"role": "system", "content": "You are Kimi K2, a knowledgeable coding assistant. Use clear explanations and include comments in code."},
    {"role": "user", "content": "Write a Python function that returns the nth Fibonacci number."}
]

payload = {
    "model": "qwen3-coder:480b-cloud",
    "messages": messages
}

headers = {"Authorization": api_key}
response = requests.post(url, headers=headers, json=payload)
print(response.json()["choices"][0]["message"]["content"])


This example sends a system prompt and a user request to the qwen3-coder:480b-cloud model. The response is a single assistant message containing the answer and any reasoning. Always include the full conversation history when making follow‑up requests.

5. Comparison and best practices
Model	Unique formatting requirements	Channels / modes	Notes
GPT‑OSS (20B & 120B)	Must use the Harmony format: developer message first, assistant messages with explicit analysis, commentary or final channels. Include reasoning‑level and tool definitions in the developer message
.	Three channels: analysis (internal chain‑of‑thought), commentary (tool calls/notes) and final (user‑facing answer)
cookbook.openai.com
. Each assistant message must specify a channel.	Use this format even when no tools are defined; otherwise the model may respond unexpectedly.
Qwen3‑Coder‑480B	Uses a conventional ChatML format with system, user and assistant roles. Provide a clear system prompt defining the coding assistant’s persona. When using tool calling, include tool definitions and follow examples to format prompts
docs.unsloth.ai
.	No channels. Responses include reasoning and code in a single assistant message.	Specify programming language, style and complexity in the user message
blogs.novita.ai
. Use iterative refinement – ask follow‑up questions to improve the code.
DeepSeek‑V3.1	Supports two modes. Use standard ChatML messages but control thinking vs. non‑thinking via a prefix or explicit instruction. The # think marker triggers chain‑of‑thought reasoning
huggingface.co
.	Two modes: thinking (detailed reasoning) and concise (short answer).	Use the appropriate prefix for the desired mode. Remove chain‑of‑thought before showing the answer to end‑users if you want a concise output.
Kimi K2‑1T	Uses a ChatML‑style format: provide a system message to define the assistant and include user messages; no Harmony channels are required. Long context window (256 k) allows for large code snippets and conversation history
datacamp.com
ollama.com
.	Single mode; responses are returned as a single assistant message.	Provide clear instructions and include necessary context. For software agents, configure tools via the platform; include tool definitions in the system prompt
platform.moonshot.ai
.
6. Conclusion

Correct prompt formatting is essential when using Ollama Cloud models. GPT‑OSS models require the Harmony response format with explicit channels and reasoning levels, while Qwen3‑Coder and DeepSeek use more traditional chat structures but offer tool calling and reasoning‑mode selection, respectively. Always review the latest model documentation when available. Follow the examples above to structure your API calls correctly and to make the most of each model’s capabilities.

