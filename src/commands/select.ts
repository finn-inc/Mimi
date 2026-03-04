import { Command } from 'commander';
import type { Config } from '../config/schema.js';
import { loadConfig } from '../config/schema.js';
import { createAiClient } from '../ai/client.js';
import { verifyArticles } from '../ai/verifier.js';
import { selectArticles } from '../ai/selector.js';
import {
  fetchUnprocessedArticlesFromNotion,
  fetchPublishedTopicsFromNotion,
  updateArticleSelectionsInNotion,
} from '../notion/publisher.js';
import type { PublishedTopic } from '../notion/publisher.js';
import { createNotionClient } from '../notion/client.js';
import { notify } from '../utils/notify.js';
import { toErrorMessage } from '../utils/error.js';

export interface SelectExecutionResult {
  unprocessed: number;
  verified: number;
  rejected: number;
  selected: number;
  updated: number;
}

export async function executeSelect(
  config: Config,
  options?: { date?: string },
): Promise<SelectExecutionResult> {
  if (!config.notion?.pipelineDataSourceId) {
    console.error('notion.pipelineDataSourceId が設定されていません。');
    return { unprocessed: 0, verified: 0, rejected: 0, selected: 0, updated: 0 };
  }

  const notionClient = createNotionClient(config.notion.tokenEnvVar);

  // 1. Notion DB から未処理記事を取得
  console.log('Notion DB から未処理記事を取得中...');
  const articles = await fetchUnprocessedArticlesFromNotion(
    notionClient,
    config.notion.pipelineDataSourceId!,
    { date: options?.date },
  );

  if (articles.length === 0) {
    const dateLabel = options?.date ?? '今日';
    console.log(`未処理の記事がありません（処理日: ${dateLabel}）。先に mimi fetch を実行してください。`);
    return { unprocessed: 0, verified: 0, rejected: 0, selected: 0, updated: 0 };
  }

  console.log(`${articles.length}件の未処理記事を取得しました。`);

  // 2. 検証
  console.log('記事を検証中...');
  const { verified, rejected } = verifyArticles(articles);

  console.log('--- 検証結果 ---');
  console.log(`  verified: ${verified.length}件`);
  console.log(`  rejected: ${rejected.length}件`);
  for (const { article, reason } of rejected) {
    console.log(`    [REJECTED] ${article.title}`);
    console.log(`              理由: ${reason}`);
  }

  if (verified.length === 0) {
    // rejected のみ更新
    if (rejected.length > 0) {
      await updateArticleSelectionsInNotion(notionClient, [], rejected, []);
    }
    console.log('検証済み記事がありません。');
    return { unprocessed: articles.length, verified: 0, rejected: rejected.length, selected: 0, updated: rejected.length };
  }

  // 3. AI スコアリング・選別
  console.log('記事を選別中...');
  const selectorClient = createAiClient('grok', config.grok.model);

  let publishedTopics: PublishedTopic[] = [];
  publishedTopics = await fetchPublishedTopicsFromNotion(
    notionClient,
    config.notion.pipelineDataSourceId!,
  );

  const { selected, scores } = await selectArticles(
    verified,
    selectorClient,
    config.selection.maxArticles,
    config.selection.criteria,
    publishedTopics,
  );

  console.log('--- 選別結果 ---');
  selected.forEach((article, index) => {
    console.log(`  ${index + 1}. ${article.title}`);
  });

  // 4. Notion DB を更新
  console.log('Notion DB を更新中...');
  const { updated, errors } = await updateArticleSelectionsInNotion(
    notionClient,
    verified,
    rejected,
    scores,
  );
  console.log(`Notion 更新完了: ${updated}件更新${errors > 0 ? `, ${errors}件エラー` : ''}`);

  return {
    unprocessed: articles.length,
    verified: verified.length,
    rejected: rejected.length,
    selected: selected.length,
    updated,
  };
}

export function registerSelectCommand(program: Command): void {
  program
    .command('select')
    .description('Notion DB の未処理記事を検証・選別し、結果を更新')
    .option('-c, --config <path>', '設定ファイルパス', 'config.yaml')
    .option('-d, --date <date>', '処理日を指定（YYYY-MM-DD）')
    .addHelpText('after', `
Examples:
  $ mimi select                    今日の未処理記事を選別
  $ mimi select -d 2026-03-04      特定日の記事を選別
  $ mimi select -c custom.yaml     カスタム設定で選別
`)
    .action(async (options: { config: string; date?: string }) => {
      try {
        notify('Mimi', '記事選別を開始します');
        console.log('記事選別を開始します...');
        const config = loadConfig(options.config);
        const result = await executeSelect(config, { date: options.date });
        notify('Mimi', `選別完了: ${result.selected}件選出`);
        console.log(`\n選別完了: ${result.unprocessed}件 → verified ${result.verified}件 / rejected ${result.rejected}件 → selected ${result.selected}件`);
      } catch (error) {
        notify('Mimi', '記事選別でエラーが発生しました');
        console.error('select コマンドでエラーが発生しました:', toErrorMessage(error));
        process.exit(1);
      }
    });
}
