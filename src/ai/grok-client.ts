import OpenAI from 'openai';
import type { AiClient, ChatOptions } from './types.js';
import { withRetry } from '../utils/retry.js';

export function createXaiClient(): OpenAI {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY 環境変数が設定されていません');
  }
  return new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1', timeout: 3 * 60 * 1000 });
}

export class GrokAiClient implements AiClient {
  readonly provider = 'grok' as const;
  private readonly client: OpenAI;

  constructor(readonly model: string) {
    this.client = createXaiClient();
  }

  async chat(systemPrompt: string, userPrompt: string, options?: ChatOptions): Promise<string> {
    const maxRetries = options?.maxRetries ?? 3;

    return withRetry(async () => {
      const params: OpenAI.ChatCompletionCreateParams = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 4096,
      };

      if (options?.responseFormat) {
        params.response_format = options.responseFormat;
      }

      const response = await this.client.chat.completions.create(params);
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty response from Grok API');
      return content;
    }, maxRetries);
  }
}
