import type { Model } from '@strands-agents/sdk';

// Local/self-hosted OpenAI-compatible endpoint (e.g. an Ollama server) —
// used as the default so the agents run for real before any sponsor model
// credentials are handed out. Override with env vars, or unset
// LOCAL_MODEL_BASE_URL to fall back to Anthropic/Bedrock instead.
//
// Read lazily (not as module-level consts) so this always sees env vars
// loaded from .env at server startup, regardless of module import order.
export function localModelBaseUrl(): string {
  return process.env.LOCAL_MODEL_BASE_URL || 'https://9ol.es/11434';
}
export function localModelId(): string {
  return process.env.LOCAL_MODEL_ID || 'qwen3.8';
}

export function hasModelCredentials(): boolean {
  return (
    Boolean(localModelBaseUrl()) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.AWS_ACCESS_KEY_ID)
  );
}

// The local endpoint's OpenAI-compat streaming proxy omits the `index`
// field on tool-call deltas (verified directly against the raw API —
// see localModel.ts), which the Strands SDK's streaming parser requires.
// Its plain non-streaming chat completions work fine, so agents route
// through integrations/localModel.ts instead of Agent+structuredOutputSchema
// specifically when this endpoint is the active provider.
export function isUsingLocalModel(): boolean {
  return Boolean(localModelBaseUrl()) && !process.env.ANTHROPIC_API_KEY && !process.env.AWS_ACCESS_KEY_ID;
}

let cachedModel: Model | undefined;

export async function getModel(): Promise<Model> {
  if (cachedModel) return cachedModel;

  const baseUrl = localModelBaseUrl();
  if (baseUrl) {
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
    cachedModel = new OpenAIModel({
      api: 'chat',
      modelId: localModelId(),
      apiKey: process.env.LOCAL_MODEL_API_KEY || 'local',
      clientConfig: { baseURL: baseUrl },
    }) as unknown as Model;
    return cachedModel;
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
    cachedModel = new AnthropicModel({ modelId: 'claude-sonnet-5' }) as unknown as Model;
    return cachedModel;
  }

  if (process.env.AWS_ACCESS_KEY_ID) {
    const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
    cachedModel = new BedrockModel({
      region: process.env.AWS_REGION || 'us-east-1',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      maxTokens: 4096,
    }) as unknown as Model;
    return cachedModel;
  }

  throw new Error(
    'No model credentials found. Set LOCAL_MODEL_BASE_URL, ANTHROPIC_API_KEY, or AWS credentials in .env — until then the app runs on the heuristic fallback path.',
  );
}
