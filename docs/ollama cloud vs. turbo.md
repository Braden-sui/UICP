Ollama Cloud – API endpoints, models and integration
Understanding Ollama Cloud versus local Ollama

Local Ollama – When you install Ollama on a PC, it exposes a REST API on port 11434. The API is available at http://localhost:11434/api (for the Ollama‑specific REST endpoints) and http://localhost:11434/v1 (for the OpenAI‑compatible endpoints). The default installation runs models on your own GPU/CPU and only allows models that fit into local VRAM (e.g., llama3:8b, mistral, etc.).

Ollama Cloud – Ollama introduced a “cloud models” feature that offloads inference to datacenter‑grade GPUs. Cloud models let you run massive models (up to hundreds of billions of parameters) without owning a huge GPU. The same tools (CLI, API, Python/JavaScript clients) can be used; you simply use a different model name (with a -cloud suffix) and point the client to the cloud host rather than localhost.

Authentication – Cloud models require an account on ollama.com. Use ollama signin in the CLI or create an API key on the web site. You pass the API key in the Authorization header when using the API. The cloud service does not retain your input data and is located in datacenters in the U.S.
docs.ollama.com
.

Differences between local and cloud endpoints
Item	Local Ollama	Ollama Cloud (remote)
Host	http://localhost:11434	https://ollama.com
API endpoints	/api/* (Ollama‑specific) and /v1/* (OpenAI‑compatible)	Same paths (/api/generate, /api/chat, /api/tags etc.) but hosted on ollama.com
Models	Local models have names such as llama3:8b and can be pulled via ollama pull. They must fit on local VRAM.	Cloud models have names ending in ‑cloud and use datacenter GPUs. You don’t download them; the inference runs in the cloud.
Authentication	No API key is needed for local access; the API listens on localhost only.	API key required. Include Authorization: <api‑key> in HTTP headers.
Usage	Models are stored on disk; inference happens locally.	Offloads inference to Ollama’s cloud hardware but allows you to use the same CLI/API.
Ollama Cloud models

The Ollama documentation lists cloud models that can be run via the CLI/API. As of September 2025, the documentation and official blog show the following models:

Model	Description	Source
qwen3‑coder:480b‑cloud	480‑billion‑parameter coding specialist. Allows running a massive coding model through the same API.	Blog on cloud models
ollama.com
 and Medium article
blog.gopenai.com

gpt‑oss:120b‑cloud	120‑billion‑parameter general‑purpose model designed for reasoning and agentic tasks.	Cloud docs and blog
ollama.com

gpt‑oss:20b‑cloud	20‑billion‑parameter compact model.	Cloud docs and blog
ollama.com

deepseek‑v3.1:671b‑cloud	671‑billion‑parameter model that was listed in the documentation
docs.ollama.com
. It may be in limited preview and might not yet appear in later blog posts.	
kimi‑k2:1t‑cloud (preview)	A 1‑trillion‑parameter model referenced in the cloud docs
docs.ollama.com
. Availability may vary because this model wasn’t mentioned in later blog posts.	

The blog notes that these models can be listed via the CLI (e.g., ollama ls) or via the cloud API. A CLI listing shows that gpt‑oss:120b‑cloud, gpt‑oss:20b‑cloud, deepseek‑v3.1:671b‑cloud and qwen3‑coder:480b‑cloud are available
ollama.com
. A more recent Medium article summarised the available models as qwen3‑coder:480b‑cloud, gpt‑oss:120b‑cloud and gpt‑oss:20b‑cloud
blog.gopenai.com
.

Using the Ollama cloud API (Ollama‑specific endpoints)

Ollama’s REST API provides endpoints for generating text, chatting, listing models, creating/pushing models and more. The same endpoints exist for local and cloud usage—the only difference is the host and the need for an API key. Key points from the API reference:

Endpoint to generate a completion: POST /api/generate. This is a streaming endpoint that returns a series of JSON objects; it can be converted to a single response by passing { "stream": false }
. Required parameters include model (the model name) and prompt (the input text)
. Optional parameters include suffix, images (for multimodal models), format (e.g., json), options (for temperature, etc.), system (system prompt), template (custom prompt template), stream (set to false for non‑streaming), raw (turn off template formatting), keep_alive (how long the model stays loaded) and context (deprecated)
.

Endpoint to generate a chat completion: POST /api/chat. It accepts a model and a list of messages with role (user, assistant or system) and content. The response is streamed unless stream: false is provided. Parameters mirror those of /api/generate.

List available models: GET /api/tags returns a list of model tags. In the cloud context, call https://ollama.com/api/tags with your API key to list available cloud models
docs.ollama.com
.

Example calls using cURL

List available cloud models (replace <API_KEY> with your API key):

curl -H "Authorization: <API_KEY>" \
     https://ollama.com/api/tags


Generate a chat response using a cloud model via the Ollama‑specific API:

curl https://ollama.com/api/chat \
  -H "Authorization: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss:120b-cloud",
    "messages": [
      {"role": "user", "content": "Why is the sky blue?"}
    ],
    "stream": false
  }'


This request calls the remote API and returns a JSON object with the model’s reply. Use "stream": true (default) to receive a stream of partial responses.

Python integration using ollama library

Ollama maintains a Python library that can connect to both local and cloud endpoints. To use it with cloud models, set the host to https://ollama.com and provide an API key in the Authorization header. The cloud documentation provides an example
docs.ollama.com
:

from ollama import Client

client = Client(
    host="https://ollama.com",
    headers={'Authorization': '<API_KEY>'}
)

messages = [
    {'role': 'user', 'content': 'Why is the sky blue?'}
]

# Stream the response from the cloud model
for part in client.chat('gpt-oss:120b', messages=messages, stream=True):
    print(part['message']['content'], end='', flush=True)


Key points:

The model name should include the -cloud suffix when addressing cloud models (e.g., gpt-oss:120b-cloud).

host must be set to https://ollama.com for cloud access; the default is http://localhost:11434 for local usage.

Provide the API key in the Authorization header.

You can disable streaming by adding stream=False to client.chat() or by passing {"stream": false} in raw requests.

JavaScript example (Node.js)

Ollama also offers a JavaScript library. The blog provides an example of using a cloud model via the library: after installing ollama and pulling a cloud model, you call ollama.chat with the model name
ollama.com
:

import ollama from "ollama";

// Set the host and API key
const client = new ollama.Client({
  host: "https://ollama.com",
  headers: { Authorization: process.env.OLLAMA_API_KEY },
});

const response = await client.chat({
  model: "gpt-oss:120b-cloud",
  messages: [{ role: "user", content: "Why is the sky blue?" }],
});

console.log(response.message.content);

Using the OpenAI‑compatible endpoints

Ollama exposes an OpenAI‑compatible API under the /v1 path. This API makes it possible to reuse existing OpenAI clients by simply changing the base URL and API key. The documentation notes that you can call the Chat Completions endpoint with the same request body you would send to OpenAI but change the hostname to your Ollama instance
. Example:

curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: ollama" \
  -d '{
    "model": "llama2",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'


For cloud usage, change the base URL to https://ollama.com and provide your API key:

curl https://ollama.com \
  -H "Content-Type: application/json" \
  -H "Authorization: <API_KEY>" \
  -d '{
    "model": "gpt-oss:120b-cloud",
    "messages": [{"role": "user", "content": "Explain gravitational lensing."}],
    "stream": false
  }'


OpenAI‑compatible endpoints available:

Endpoint	Description
GET /v1/models	Returns a list of available models. For cloud, this will show cloud models as well.
POST /v1/chat/completions	Generates a chat response using the Chat Completions API (similar to OpenAI’s).
POST /v1/completions	Generates a completion for a single prompt.
POST /v1/embeddings	Returns vector embeddings for the provided input.

These endpoints are stateless; they do not persist conversation history between requests (unless you include prior messages yourself). Use the Ollama‑specific /api/chat endpoint if you need built‑in conversation context and features like keep_alive.

Key considerations when coding against Ollama Cloud

Use the correct base URL and model name – The main difference between cloud and local use is the host (https://ollama.com vs. http://localhost:11434) and the model name (cloud models end in ‑cloud). Ensure your code points to the proper host and that you specify the correct model tag. The Python client example shows how to set the host and model
docs.ollama.com
.

Authenticate with an API key – All cloud API calls must include an Authorization header containing your API key. Without it, requests will fail. You can create and manage API keys in your Ollama account.

Streaming vs. non‑streaming – The API streams responses by default. To get a single JSON response, set "stream": false in the request body or use the stream=False parameter in the client library.

Rate limits and usage caps – The cloud documentation notes that cloud models include hourly and daily limits to avoid capacity issues, and usage‑based pricing will be introduced
ollama.com
. Plan your application accordingly.

OpenAI compatibility – For projects built against OpenAI’s Chat Completions API, you can switch to Ollama by changing the base URL to https://ollama.com (or http://localhost:11434/v1 for local) and using your API key. However, advanced OpenAI features (tools/functions, vision, etc.) may not be fully supported because Ollama’s compatibility is experimental.

Summary

Ollama Cloud allows developers to run extremely large, open‑weight language models without having a large GPU. Cloud models have names ending with ‑cloud and are served via https://ollama.com, while local models live under http://localhost:11434. The same API structure (Ollama‑specific endpoints under /api and OpenAI‑compatible endpoints under /v1) works for both local and cloud usage; the key differences are the host, the need for an API key and the model names. Developers can integrate these models into Python, JavaScript or any language capable of making HTTP requests, taking advantage of streaming responses and the ability to specify system prompts, templates and other options
. By following the guidelines above, you can build applications that seamlessly switch between local and cloud inference while harnessing the power of huge models offered by Ollama Cloud.