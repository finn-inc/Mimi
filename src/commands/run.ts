import { Command } from 'commander';
import { loadConfig } from '../config/schema.js';
import { executeFetch } from './fetch.js';
import { executeSelect } from './select.js';
import { executePipeline } from './pipeline.js';
import { notify } from '../utils/notify.js';
import { toErrorMessage } from '../utils/error.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('fetch→select→pipelineの全パイプラインを一括実行')
    .option('-c, --config <path>', '設定ファイルパス', 'config.yaml')
    .addHelpText('after', `
Examples:
  $ mimi run                    fetch→select→pipeline を一括実行
  $ mimi run -c custom.yaml     カスタム設定で一括実行
`)
    .action(async (options: { config: string }) => {
      try {
        notify('Mimi', 'パイプラインを開始します');
        console.log('パイプラインを開始します...');

        const config = loadConfig(options.config);

        // === Step 1: Fetch ===
        notify('Mimi [1/3]', '記事を収集中...');
        console.log('\n[1/3] ソースから記事を収集中...');
        const fetchResult = await executeFetch(config);

        if (fetchResult.recent === 0) {
          console.log('収集記事がありません。処理を終了します。');
          return;
        }
        notify('Mimi [1/3]', `記事収集完了: ${fetchResult.recent}件`);

        // === Step 2: Select ===
        notify('Mimi [2/3]', '記事を検証・選別中...');
        console.log('\n[2/3] 記事を検証・選別中...');
        const selectResult = await executeSelect(config);

        if (selectResult.selected === 0) {
          console.log('選別済み記事がありません。処理を終了します。');
          return;
        }
        notify('Mimi [2/3]', `選別完了: ${selectResult.selected}件`);

        // === Step 3: Pipeline ===
        notify('Mimi [3/3]', 'パイプラインを実行中...');
        console.log('\n[3/3] 多段階パイプラインを実行中...');
        const pipelineResult = await executePipeline(config);

        notify('Mimi [3/3]', `パイプライン完了: ${pipelineResult.processed}件`);

        // === 最終サマリー ===
        console.log('\n========================================');
        console.log('パイプライン完了');
        console.log('========================================');
        console.log(`収集: ${fetchResult.totalFetched}件 → 重複除去後 ${fetchResult.deduped}件 → 直近 ${fetchResult.recent}件`);
        console.log(`検証: ${selectResult.unprocessed}件 → verified ${selectResult.verified}件 / rejected ${selectResult.rejected}件`);
        console.log(`選別: ${selectResult.verified}件 → ${selectResult.selected}件`);
        console.log(`パイプライン処理: ${pipelineResult.processed}件`);
        notify('Mimi', 'パイプライン完了！');
      } catch (error) {
        notify('Mimi', 'パイプラインでエラーが発生しました');
        console.error('run コマンドでエラーが発生しました:', toErrorMessage(error));
        process.exit(1);
      }
    });
}
