import type { AiClient } from '../types.js';
import type { Article } from '../../sources/types.js';
import type { PipelineConfig, PipelineResult } from './types.js';
import { generateKnowledge } from './knowledge.js';
import { progressiveSummarize } from './summarize.js';
import { generateTweet } from './tweet.js';

export async function runPipeline(
  articles: Article[],
  client: AiClient,
  config: PipelineConfig,
  tone: string,
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];

  for (const article of articles) {
    const result: PipelineResult = {
      articleId: article.id,
      title: article.title,
    };

    // Stage 1: Knowledge
    if (config.stages.includes('knowledge')) {
      console.log(`  [Knowledge] ${article.title}`);
      result.knowledge = await generateKnowledge(article, client, tone);
    }

    // Stage 2: Summarize
    if (config.stages.includes('summary') && result.knowledge) {
      console.log(`  [Summary] ${article.title}`);
      const allSummaries = [];
      for (const audience of config.summary.audiences) {
        const summaries = await progressiveSummarize(
          result.knowledge.content,
          article.id,
          audience,
          config.summary.rounds,
          client,
        );
        allSummaries.push(...summaries);
      }
      result.summaries = allSummaries;
    }

    // Stage 3: Tweet
    if (config.stages.includes('tweet')) {
      const sourceContent = result.summaries?.at(-1)?.content
        ?? result.knowledge?.content
        ?? '';
      if (sourceContent) {
        console.log(`  [Tweet] ${article.title}`);
        result.tweet = await generateTweet(
          sourceContent,
          article.id,
          article.url,
          client,
          config.tweet,
        );
      }
    }

    results.push(result);
  }

  return results;
}
