import { Command } from 'commander';
import { loadConfig } from '../config/schema.js';
import { ArticleStore } from '../store/articles.js';
import type { PublishedTopic } from '../store/articles.js';
import { RssAdapter } from '../sources/rss.js';
import { HackerNewsAdapter } from '../sources/hackernews.js';
import { BlueskyAdapter } from '../sources/bluesky.js';
import { XSearchAdapter } from '../sources/xsearch.js';
import { BlueskySearchAdapter } from '../sources/bluesky-search.js';
import { XSearchKeywordAdapter } from '../sources/xsearch-keyword.js';
import type { SourceAdapter, FetchResult } from '../sources/types.js';
import { createAiClient } from '../ai/client.js';
import { verifyArticles } from '../ai/verifier.js';
import { selectArticles } from '../ai/selector.js';
import { generateArticle } from '../ai/generator.js';
import { notify } from '../utils/notify.js';
import { initNotionContext, publishArticleToNotion, publishArticleToDatabase, checkDuplicateInDatabase } from '../notion/publisher.js';
import { createNotionClient } from '../notion/client.js';
import { toErrorMessage } from '../utils/error.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('fetch→select→generateの全パイプラインを一括実行')
    .option('-c, --config <path>', '設定ファイルパス', 'config.yaml')
    .addHelpText('after', `
Examples:
  $ mimi run                    fetch→select→generate を一括実行
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

        const adapters: SourceAdapter[] = [];
        for (const source of config.sources) {
          if (source.type === 'rss') {
            adapters.push(new RssAdapter(source));
          } else if (source.type === 'hackernews') {
            adapters.push(new HackerNewsAdapter(source));
          } else if (source.type === 'bluesky') {
            adapters.push(new BlueskyAdapter(source));
          } else if (source.type === 'xsearch') {
            try {
              adapters.push(new XSearchAdapter(source));
            } catch (error) {
              console.warn(`XSearch ソースをスキップ: ${toErrorMessage(error)}`);
            }
          } else if (source.type === 'bluesky-search') {
            adapters.push(new BlueskySearchAdapter(source));
          } else if (source.type === 'xsearch-keyword') {
            try {
              adapters.push(new XSearchKeywordAdapter(source));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`⚠️  XSearch Keyword ソースをスキップ: ${message}`);
            }
          }
        }

        if (adapters.length === 0) {
          console.log('有効なソースアダプタがありません。処理を終了します。');
          return;
        }

        console.log(`${adapters.length}件のソースから記事を収集中...`);

        const results = await Promise.allSettled(
          adapters.map(adapter => adapter.fetch())
        );

        const fetchResults: FetchResult[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            fetchResults.push(result.value);
          } else {
            console.error('アダプタ実行エラー:', result.reason);
          }
        }

        const allArticles = fetchResults.flatMap(r => r.articles);
        const store = new ArticleStore();
        const { articles: recent, totalCount, newCount } = store.merge('fetched.json', allArticles);
        store.appendHistory({ timestamp: new Date().toISOString(), filename: 'fetched.json', count: totalCount, newCount });

        console.log('--- 収集結果 ---');
        for (const result of fetchResults) {
          const errorSuffix = result.errors.length > 0
            ? ` (エラー ${result.errors.length}件)`
            : '';
          console.log(`  ${result.source}: ${result.articles.length}件${errorSuffix}`);
        }
        console.log(`合計: ${allArticles.length}件収集 → 新規追加 ${newCount}件 / 累計 ${totalCount}件`);

        if (recent.length === 0) {
          console.log('収集記事がありません。処理を終了します。');
          return;
        }

        notify('Mimi [1/3]', `記事収集完了: 新規${newCount}件 / 累計${totalCount}件`);

        // === Step 2: Select ===
        notify('Mimi [2/3]', '記事を検証・選別中...');
        console.log('\n[2/3] 記事を検証・選別中...');

        // Select: 常に Grok を使用
        const selectorClient = createAiClient('grok', config.grok.model);

        console.log('記事を検証中...');
        const { verified, rejected } = verifyArticles(recent);

        console.log('--- 検証結果 ---');
        console.log(`  verified: ${verified.length}件`);
        console.log(`  rejected: ${rejected.length}件`);
        for (const { article, reason } of rejected) {
          console.log(`    [REJECTED] ${article.title}`);
          console.log(`              理由: ${reason}`);
        }

        store.save('verified.json', verified);
        console.log(`verified.json に ${verified.length}件を保存しました。`);

        if (verified.length === 0) {
          console.log('検証済み記事がありません。処理を終了します。');
          return;
        }

        console.log('記事を選別中...');
        const publishedTopics = store.loadPublishedTopics();
        const selected = await selectArticles(
          verified,
          selectorClient,
          config.selection.maxArticles,
          config.selection.criteria,
          publishedTopics
        );

        console.log('--- 選別結果 ---');
        selected.forEach((article, index) => {
          console.log(`  ${index + 1}. ${article.title}`);
        });

        store.save('selected.json', selected);
        console.log(`selected.json に ${selected.length}件を保存しました。`);

        if (selected.length === 0) {
          console.log('選別済み記事がありません。処理を終了します。');
          return;
        }

        notify('Mimi [2/3]', `選別完了: ${selected.length}件`);

        // === Step 3: Generate ===
        notify('Mimi [3/3]', '記事を生成中...');
        console.log('\n[3/3] 記事を生成中...');

        const tone = config.output.tone;
        let generatedCount = 0;

        // Generate: 常に Claude
        const generatorClient = createAiClient('anthropic', config.claude.model);

        // Notion クライアント初期化（設定がある場合のみ）
        // articleDbId がある場合は DB 直接書き込みモード、ない場合は日付ページモード
        const notionCtx = (config.notion && !config.notion.articleDbId)
          ? await initNotionContext(config.notion)
          : null;
        const notionDbClient = (config.notion?.articleDbId)
          ? createNotionClient(config.notion.tokenEnvVar)
          : null;

        // DB 直接書き込みモードの場合、重複チェック用の既存 URL セットを取得
        const existingUrls = (notionDbClient && config.notion?.articleDataSourceId)
          ? await checkDuplicateInDatabase(notionDbClient, config.notion.articleDataSourceId)
          : null;

        const newPublishedTopics: PublishedTopic[] = [];

        const total = selected.length;
        const startTime = Date.now();
        let completed = 0;
        let failed = 0;

        // 15秒ごとの進捗表示
        const progressInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  ⏳ 進捗: ${completed + failed}/${total}件完了 (${elapsed}秒経過)`);
        }, 15_000);

        // 全記事を並列生成
        const generateResults = await Promise.allSettled(
          selected.map(async (article, index) => {
            const label = `[${index + 1}/${total}]`;
            console.log(`${label} 生成開始: ${article.title}`);
            const articleStart = Date.now();
            const content = await generateArticle(article, generatorClient, tone);
            const secs = ((Date.now() - articleStart) / 1000).toFixed(1);
            console.log(`${label} 生成完了: ${article.title} (${secs}秒)`);
            completed++;
            return { article, content };
          })
        );

        clearInterval(progressInterval);

        // 元の順序で Notion に出力
        for (let i = 0; i < generateResults.length; i++) {
          const result = generateResults[i];
          if (result.status === 'fulfilled') {
            const { article, content } = result.value;
            if (notionDbClient && config.notion?.articleDbId) {
              // DB 直接書き込みモード（articleDbId あり）
              const articleUrl = article.url ?? '';
              if (existingUrls && articleUrl && existingUrls.has(articleUrl)) {
                console.log(`  → 重複スキップ: ${article.title} (${articleUrl})`);
              } else {
                const pubResult = await publishArticleToDatabase(
                  notionDbClient,
                  config.notion.articleDbId,
                  article.title,
                  content,
                );
                if (pubResult.success) {
                  console.log(`  → Notion DB に公開: ${pubResult.notionPageUrl}`);
                } else {
                  console.warn(`  ⚠ Notion 公開失敗: ${pubResult.error}`);
                  console.log(content);
                }
              }
            } else if (notionCtx) {
              // 日付ページモード（後方互換）
              const pubResult = await publishArticleToNotion(
                notionCtx.client,
                notionCtx.datePage.id,
                article.title,
                content,
                notionCtx.firstBlockId,
              );
              if (pubResult.success) {
                console.log(`  → Notion に公開: ${pubResult.notionPageUrl}`);
              } else {
                console.warn(`  ⚠ Notion 公開失敗: ${pubResult.error}`);
                console.log(content);
              }
            } else {
              console.log(content);
            }
            generatedCount++;
            newPublishedTopics.push({
              id: article.id,
              title: article.title,
              topic: article.title,
              publishedAt: new Date().toISOString(),
              url: article.url,
            });
          } else {
            failed++;
            console.error(`  エラー: ${selected[i].title} の生成に失敗しました:`, toErrorMessage(result.reason));
          }
        }

        // 全記事処理後にまとめて保存
        if (newPublishedTopics.length > 0) {
          store.savePublishedTopics(newPublishedTopics);
        }

        notify('Mimi [3/3]', `生成完了: ${generatedCount}件`);

        // === 最終サマリー ===
        console.log('\n========================================');
        console.log('パイプライン完了');
        console.log('========================================');
        console.log(`収集: ${allArticles.length}件 → 新規追加 ${newCount}件 / 累計 ${totalCount}件`);
        console.log(`検証: ${recent.length}件 → verified ${verified.length}件 / rejected ${rejected.length}件`);
        console.log(`選別: ${verified.length}件 → ${selected.length}件`);
        console.log(`生成: ${generatedCount}件`);
        notify('Mimi', 'パイプライン完了！');
      } catch (error) {
        notify('Mimi', 'パイプラインでエラーが発生しました');
        console.error('run コマンドでエラーが発生しました:', toErrorMessage(error));
        process.exit(1);
      }
    });
}
