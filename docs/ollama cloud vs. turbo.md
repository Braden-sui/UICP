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
Authentication	No API key is needed for local access; the API listens on localhost only.	API key required. Include Authorization: Bearer <api‑key> in HTTP headers.

Usage	Models are stored on disk; inference happens locally.	Offloads inference to Ollama’s cloud hardware but allows you to use the same CLI/API.
Ollama Cloud models

The Ollama documentation lists cloud models that can be run via the CLI/API. As of September 2025, the documentation and official blog show the following models:

{{ ... }}

Example calls using cURL

List available cloud models (replace <API_KEY> with your API key):

curl -H "Authorization: Bearer <API_KEY>" \
     https://ollama.com/api/tags



Generate a chat response using a cloud model via the Ollama‑specific API:

curl https://ollama.com/api/chat \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \

  -d '{
    "model": "gpt-oss:120b-cloud",
    "messages": [
      {"role": "user", "content": "Why is the sky blue?"}
    ],
{{ ... }}
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