import type { AiClient } from '../types.js';
import type { StageOutput } from './types.js';

export async function generateTweet(
  summaryContent: string,
  articleId: string,
  articleUrl: string,
  client: AiClient,
  options: { maxChars: number; includeHashtags: boolean; hashtagCount: number },
): Promise<StageOutput> {
  const hashtagInstruction = options.includeHashtags
    ? `- 末尾にハッシュタグを${options.hashtagCount}個付ける（AI関連の日本語ハッシュタグ）`
    : '- ハッシュタグは不要';

  const systemPrompt = `あなたはAI/ML技術情報をX（Twitter）で発信するエキスパートです。

## ルール
- ${options.maxChars}文字以内に収める（URLは別カウント）
- 記事の最も重要なポイントを1つに絞って伝える
- 読者が「続きを読みたい」と思うような書き出しにする
${hashtagInstruction}
- 絵文字は1-2個まで`;

  const userPrompt = `以下の要約からX投稿用テキストを作成してください。記事URL: ${articleUrl}

${summaryContent}`;

  const content = await client.chat(systemPrompt, userPrompt);

  return {
    articleId,
    stage: 'tweet',
    content,
    metadata: { maxChars: options.maxChars, url: articleUrl },
  };
}
