// Conceptual interface definition (details may vary)
interface ModelProvider {
  id: string; // Unique identifier for the provider (e.g., 'openrouter', 'ollama')
  name: string; // Display name (e.g., 'OpenRouter', 'Ollama Local')
  icon?: string; // Optional icon for UI representation
  isEnabled(): boolean; // Check if the provider is configured and active
  getModels(): Promise<Array<{ id: string; name: string; capabilities: string[] }>>; // List available models
  generate(options: GenerateOptions): Promise<Response>; // One-shot generation
  streamGenerate(options: GenerateOptions): AsyncIterable<Chunk>; // Streaming generation
  // ... other potential methods like embeddings, etc.
}

interface GenerateOptions {
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  tools?: any[]; // For tool calling
  temperature?: number;
  maxTokens?: number;
  // ... other common LLM parameters
}

interface Response {
  content: string;
  tool_calls?: any[];
  // ... other response metadata
}

interface Chunk {
  content?: string;
  tool_calls_delta?: any[];
  // ... other stream chunk metadata
}