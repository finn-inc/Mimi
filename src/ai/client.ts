import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from '../utils/retry.js';
import type { AiClient, ChatOptions } from './types.js';
import { GrokAiClient } from './grok-client.js';

export type { AiClient, ChatOptions } from './types.js';

async function callClaude(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxRetries = 3
): Promise<string> {
  return withRetry(async () => {
    const message = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      throw new Error(`Unexpected response type: ${content.type}`);
    }
    return content.text;
  }, maxRetries);
}

export class AnthropicAiClient implements AiClient {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(readonly model: string) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY が設定されていません。.env ファイルまたは環境変数に設定してください。');
    }
    this.client = new Anthropic({ timeout: 3 * 60 * 1000 });
  }

  async chat(systemPrompt: string, userPrompt: string, options?: ChatOptions): Promise<string> {
    return callClaude(this.client, this.model, systemPrompt, userPrompt, options?.maxRetries);
  }
}

export function createAiClient(provider: 'anthropic' | 'grok', model: string): AiClient {
  if (provider === 'grok') return new GrokAiClient(model);
  return new AnthropicAiClient(model);
}
