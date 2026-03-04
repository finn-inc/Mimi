#!/usr/bin/env -S node --import tsx/esm
import { config } from 'dotenv';
config({ path: '.env' });

import { Command } from 'commander';
import { loadConfig } from './config/schema.js';
import { registerRunCommand } from './commands/run.js';
import { registerAccountsCommand } from './commands/accounts.js';
import { registerPipelineCommand } from './commands/pipeline.js';
import { registerFetchCommand } from './commands/fetch.js';
import { registerSelectCommand } from './commands/select.js';

const program = new Command();

program
  .name('mimi')
  .description('海外AI情報監視・翻訳CLIツール')
  .version('0.1.0');

// sourcesコマンド: 登録ソース一覧表示
program
  .command('sources')
  .description('登録されているソース一覧を表示')
  .option('-c, --config <path>', '設定ファイルパス', 'config.yaml')
  .addHelpText('after', `
Examples:
  $ mimi sources                デフォルト設定のソース一覧
  $ mimi sources -c custom.yaml カスタム設定ファイル
`)
  .action((options: { config: string }) => {
    try {
      const config = loadConfig(options.config);
      console.log('登録ソース一覧:');
      config.sources.forEach((source, index) => {
        if (source.type === 'rss') {
          console.log(`  ${index + 1}. [RSS] ${source.name} - ${source.url}`);
        } else if (source.type === 'hackernews') {
          console.log(`  ${index + 1}. [HackerNews] キーワード: ${source.keywords.join(', ')} (最低スコア: ${source.minScore})`);
        } else if (source.type === 'reddit') {
          console.log(`  ${index + 1}. [Reddit] r/${source.subreddit} (最低アップボート: ${source.minUpvotes})`);
        } else if (source.type === 'arxiv') {
          console.log(`  ${index + 1}. [arXiv] カテゴリ: ${source.categories.join(', ')} (最大件数: ${source.maxResults})`);
        } else if (source.type === 'bluesky') {
          console.log(`  ${index + 1}. [Bluesky] アカウント: ${source.accounts.join(', ')} (最大件数: ${source.limit})`);
        } else if (source.type === 'xsearch') {
          console.log(`  ${index + 1}. [XSearch] アカウント: ${source.accounts.join(', ')} (モデル: ${source.model})`);
        } else if (source.type === 'bluesky-search') {
          console.log(`  ${index + 1}. [Bluesky Search] キーワード: ${source.keywords.join(', ')} (言語: ${source.lang}, 最大件数: ${source.limit})`);
        } else if (source.type === 'xsearch-keyword') {
          console.log(`  ${index + 1}. [XSearch Keyword] キーワード: ${source.keywords.join(', ')} (${source.daysBack}日前まで)`);
        }
      });
    } catch (error) {
      console.error('設定ファイルの読み込みに失敗しました:', error);
      process.exit(1);
    }
  });

registerFetchCommand(program);
registerSelectCommand(program);
registerRunCommand(program);
registerAccountsCommand(program);
registerPipelineCommand(program);

program.addHelpText('after', `
Examples:
  $ mimi run                    fetch→select→pipeline を一括実行
  $ mimi fetch                  ソースから記事を収集（Notion DB 保存）
  $ mimi select                 未処理記事を検証・選別
  $ mimi pipeline               選出記事からコンテンツ生成
  $ mimi pipeline -d 2026-03-04  過去の処理日を指定して実行
  $ mimi accounts list          監視アカウント一覧
  $ mimi sources                ソース一覧を表示
`);

program.parse();
