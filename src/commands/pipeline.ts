import { Command } from 'commander';
import type { Config } from '../config/schema.js';
import { loadConfig } from '../config/schema.js';
import { createAiClient } from '../ai/client.js';
import { runPipeline } from '../ai/stages/pipeline.js';
import type { PipelineConfig } from '../ai/stages/types.js';
import { toErrorMessage } from '../utils/error.js';
import { checkDuplicateInDatabase, publishContentToPipelineDb, fetchSelectedArticlesFromNotion } from '../notion/publisher.js';
import { createNotionClient } from '../notion/client.js';
import { notify } from '../utils/notify.js';

export interface PipelineExecutionResult {
  processed: number;
  knowledge: number;
  summaries: number;
  tweets: number;
}

export async function executePipeline(
  config: Config,
  options?: { date?: string; articleId?: string },
): Promise<PipelineExecutionResult> {
  if (!config.notion?.pipelineDataSourceId) {
    console.error('notion.pipelineDataSourceId が設定されていません。config.yaml を確認してください。');
    return { processed: 0, knowledge: 0, summaries: 0, tweets: 0 };
  }

  const notionClient = createNotionClient(config.notion.tokenEnvVar);
  const allSelected = await fetchSelectedArticlesFromNotion(
    notionClient,
    config.notion.pipelineDataSourceId!,
    { date: options?.date },
  );

  if (allSelected.length === 0) {
    const dateLabel = options?.date ?? '今日';
    console.log(`Notion DB に選出済み記事がありません（処理日: ${dateLabel}）。先に mimi select を実行してください。`);
    return { processed: 0, knowledge: 0, summaries: 0, tweets: 0 };
  }

  const articles = options?.articleId
    ? allSelected.filter(a => a.id === options.articleId)
    : allSelected;

  if (articles.length === 0) {
    console.log(`記事ID "${options?.articleId}" が見つかりません。`);
    return { processed: 0, knowledge: 0, summaries: 0, tweets: 0 };
  }

  const pipelineConfig: PipelineConfig = config.pipeline ?? {
    stages: ['knowledge', 'summary', 'tweet'],
    summary: {
      audiences: [{ name: 'エンジニア', description: 'AIツールを使う開発者。すぐ試せる情報を重視。', maxLength: 800 }],
      rounds: 2,
    },
    tweet: { maxChars: 280, includeHashtags: true, hashtagCount: 3 },
  };

  const client = createAiClient('anthropic', config.claude.model);
  const existingPages = await checkDuplicateInDatabase(notionClient, config.notion.pipelineDataSourceId!);

  console.log(`パイプライン開始: ${articles.length}件の記事を処理します`);
  console.log(`ステージ: ${pipelineConfig.stages.join(' → ')}`);

  const results = await runPipeline(articles, client, pipelineConfig, config.output.tone);

  let knowledgeCount = 0;
  let summaryCount = 0;
  let tweetCount = 0;

  if (pipelineConfig.stages.includes('knowledge')) {
    knowledgeCount = results.filter(r => r.knowledge).length;
    console.log(`\nknowledge: ${knowledgeCount}件を生成`);

    for (const result of results) {
      if (!result.knowledge) continue;
      const article = articles.find(a => a.id === result.articleId);
      if (!article) continue;

      const pubResult = await publishContentToPipelineDb(
        notionClient,
        config.notion.pipelineDatabaseId!,
        existingPages,
        article,
        article.title,
        result.knowledge.content,
      );
      if (pubResult.success) {
        console.log(`  → Notion に公開: ${pubResult.notionPageUrl}`);
      } else {
        console.warn(`  ⚠ Notion 公開失敗: ${pubResult.error}`);
      }
    }
  }

  if (pipelineConfig.stages.includes('summary')) {
    summaryCount = results.flatMap(r => r.summaries ?? []).length;
    console.log(`summary: ${summaryCount}件を生成`);
  }

  if (pipelineConfig.stages.includes('tweet')) {
    tweetCount = results.filter(r => r.tweet).length;
    console.log(`tweet: ${tweetCount}件を生成`);

    console.log('\n--- 生成されたツイート ---');
    for (const result of results) {
      if (result.tweet) {
        console.log(`\n[${result.title}]`);
        console.log(result.tweet.content);
      }
    }
  }

  return { processed: results.length, knowledge: knowledgeCount, summaries: summaryCount, tweets: tweetCount };
}

export function registerPipelineCommand(program: Command): void {
  program
    .command('pipeline')
    .description('多段階パイプライン実行（Notion DB → KB → 要約 → ツイート）')
    .option('-c, --config <path>', '設定ファイルパス', 'config.yaml')
    .option('-a, --article-id <id>', '特定記事のみ処理')
    .option('-d, --date <date>', '処理日を指定（YYYY-MM-DD）')
    .addHelpText('after', `
Examples:
  $ mimi pipeline              Notion DB から選出記事を取得して実行
  $ mimi pipeline -d 2026-03-04  過去の処理日を指定して実行
  $ mimi pipeline -a abc123    特定記事のみ
`)
    .action(async (options: { config: string; articleId?: string; date?: string }) => {
      try {
        notify('Mimi', 'パイプラインを開始します');
        console.log('パイプラインを開始します...');
        const config = loadConfig(options.config);
        const result = await executePipeline(config, { date: options.date, articleId: options.articleId });
        notify('Mimi', `パイプライン完了: ${result.processed}件処理`);
        console.log('\nパイプライン完了');
      } catch (error) {
        notify('Mimi', 'パイプラインでエラーが発生しました');
        console.error('pipeline コマンドでエラーが発生しました:', toErrorMessage(error));
        process.exit(1);
      }
    });
}
