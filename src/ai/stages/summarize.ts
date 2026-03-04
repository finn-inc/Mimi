import type { AiClient } from '../types.js';
import type { StageOutput, AudienceConfig } from './types.js';

export async function summarizeForAudience(
  knowledgeContent: string,
  articleId: string,
  audience: AudienceConfig,
  maxLength: number,
  client: AiClient,
): Promise<StageOutput> {
  const systemPrompt = `あなたは技術記事を特定の読者層向けに要約するエキスパートです。

## ターゲット読者
- ${audience.name}: ${audience.description}

## ルール
- 元の記事の重要ポイントを保ちつつ、ターゲット読者に最も有用な情報を優先する
- ${maxLength}文字以内に収める
- 箇条書きを活用して読みやすくする
- 技術用語は必要に応じ原語を併記する`;

  const userPrompt = `以下の記事を${audience.name}向けに${maxLength}文字以内で要約してください。

${knowledgeContent}`;

  const content = await client.chat(systemPrompt, userPrompt);

  return {
    articleId,
    stage: 'summary',
    content,
    metadata: { audience: audience.name, maxLength },
  };
}

export async function progressiveSummarize(
  knowledgeContent: string,
  articleId: string,
  audience: AudienceConfig,
  rounds: number,
  client: AiClient,
): Promise<StageOutput[]> {
  const outputs: StageOutput[] = [];
  let currentContent = knowledgeContent;
  let currentMaxLength = audience.maxLength;

  for (let round = 0; round < rounds; round++) {
    const output = await summarizeForAudience(
      currentContent,
      articleId,
      audience,
      currentMaxLength,
      client,
    );
    outputs.push(output);
    currentContent = output.content;
    currentMaxLength = Math.floor(currentMaxLength / 2);
  }

  return outputs;
}
