import { Command } from 'commander';
import { loadConfig } from '../config/schema.js';
import { ArticleStore } from '../store/articles.js';
import type { PublishedTopic } from '../store/articles.js';
import { createAiClient } from '../ai/client.js';
import { generateArticle } from '../ai/generator.js';
import { initNotionContext, publishArticleToNotion, publishArticleToDatabase, checkDuplicateInDatabase } from '../notion/publisher.js';
import { createNotionClient } from '../notion/client.js';
import { toErrorMessage } from '../utils/error.js';

export function registerGenerateCommand(program: Command): void {
  program
    .command('generate [article-id]')
    .description('選別済み記事を日本語解説記事として生成')
    .option('-c, --config <path>', '設定ファイルパス', 'config.yaml')
    .addHelpText('after', `
Examples:
  $ mimi generate               全選別済み記事を生成
  $ mimi generate abc123        指定IDの記事のみ生成
`)
    .action(async (articleId: string | undefined, options: { config: string }) => {
      try {
        const config = loadConfig(options.config);

        const store = new ArticleStore();

        // selected.json から記事を読み込み
        const allArticles = store.load('selected.json');
        if (allArticles.length === 0) {
          console.log('選別済み記事が見つかりません。先に select コマンドを実行してください。');
          return;
        }

        // article-id 指定時はその記事のみ処理
        const targetArticles = articleId
          ? allArticles.filter(a => a.id === articleId)
          : allArticles;

        if (targetArticles.length === 0) {
          console.log(`記事 ID "${articleId}" が見つかりません。`);
          return;
        }

        console.log(`${targetArticles.length}件の記事を生成します...`);

        const client = createAiClient('anthropic', config.claude.model);
        const tone = config.output.tone;

        // Notion クライアント初期化
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

        const publishedTopics: PublishedTopic[] = [];

        const total = targetArticles.length;
        const startTime = Date.now();
        let completed = 0;
        let failed = 0;

        // 15秒ごとの進捗表示
        const progressInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  ⏳ 進捗: ${completed + failed}/${total}件完了 (${elapsed}秒経過)`);
        }, 15_000);

        // 全記事を並列生成
        const results = await Promise.allSettled(
          targetArticles.map(async (article, index) => {
            const label = `[${index + 1}/${total}]`;
            console.log(`${label} 生成開始: ${article.title}`);
            const articleStart = Date.now();
            const content = await generateArticle(article, client, tone);
            const secs = ((Date.now() - articleStart) / 1000).toFixed(1);
            console.log(`${label} 生成完了: ${article.title} (${secs}秒)`);
            completed++;
            return { article, content };
          })
        );

        clearInterval(progressInterval);

        // 元の順序で Notion に出力
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
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
            publishedTopics.push({
              id: article.id,
              title: article.title,
              topic: article.title,
              publishedAt: new Date().toISOString(),
              url: article.url,
            });
          } else {
            failed++;
            console.error(`  エラー: ${targetArticles[i].title} の生成に失敗しました:`, toErrorMessage(result.reason));
          }
        }

        // 全記事処理後にまとめて保存
        if (publishedTopics.length > 0) {
          store.savePublishedTopics(publishedTopics);
        }

        console.log('\n完了しました。');
      } catch (error) {
        console.error('generate コマンドでエラーが発生しました:', toErrorMessage(error));
        process.exit(1);
      }
    });
}
