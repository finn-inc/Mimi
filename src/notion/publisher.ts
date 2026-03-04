import { Client } from '@notionhq/client';
import { markdownToBlocks } from './markdown-to-blocks.js';
import type { PublishResult } from './types.js';
import type { Article, SourceType } from '../sources/types.js';
import type { SelectionScore } from '../ai/selector.js';

export interface PublishedTopic {
  id: string;
  title: string;
  topic: string;
  publishedAt: string;
  url: string;
}

export async function checkDuplicateInDatabase(
  client: Client,
  dataSourceId: string,
): Promise<Map<string, string>> {
  const existingUrls = new Map<string, string>();
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const page of response.results) {
      if (!('properties' in page)) continue;
      const pageId = (page as { id: string }).id;
      const props = page.properties as Record<string, unknown>;
      // URL プロパティを探す（"記事URL" or any url type）
      for (const prop of Object.values(props)) {
        if (prop && typeof prop === 'object' && 'type' in prop && (prop as Record<string, unknown>).type === 'url') {
          const urlValue = (prop as Record<string, unknown>).url;
          if (typeof urlValue === 'string' && urlValue) {
            existingUrls.set(urlValue, pageId);
          }
        }
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return existingUrls;
}

function mapSourceToNotion(source: SourceType): string {
  switch (source) {
    case 'bluesky':
    case 'bluesky-search':
      return 'Bluesky';
    case 'xsearch':
    case 'xsearch-keyword':
      return 'Twitter/X';
    case 'hackernews':
      return 'HackerNews';
    case 'rss':
    case 'reddit':
    case 'arxiv':
    default:
      return 'RSS';
  }
}

export async function savePipelineResultsToNotion(
  client: Client,
  dataSourceId: string,
  databaseId: string,
  dateDataSourceId: string | undefined,
  dateDateDatabaseId: string | undefined,
  verified: Article[],
  rejected: { article: Article; reason: string }[],
  scores: SelectionScore[],
): Promise<{ saved: number; skipped: number }> {
  // Build a score lookup map
  const scoreMap = new Map(scores.map(s => [s.id, s]));

  // Get existing URLs for dedup
  const existingUrls = await checkDuplicateInDatabase(client, dataSourceId);

  const today = new Date().toISOString().split('T')[0];
  let saved = 0;
  let skipped = 0;
  const createdPageIds: string[] = [];

  // Process all articles (verified + rejected)
  const allEntries: { article: Article; verdict: '合格' | '除外' }[] = [
    ...verified.map(a => ({ article: a, verdict: '合格' as const })),
    ...rejected.map(r => ({ article: r.article, verdict: '除外' as const })),
  ];

  for (const { article, verdict } of allEntries) {
    if (existingUrls.has(article.url) || (article.primarySourceUrl && existingUrls.has(article.primarySourceUrl))) {
      skipped++;
      continue;
    }

    const score = scoreMap.get(article.id);
    const publishedDate = article.publishedAt
      ? new Date(article.publishedAt).toISOString().split('T')[0]
      : undefined;
    const fetchedDate = article.fetchedAt
      ? new Date(article.fetchedAt).toISOString().split('T')[0]
      : today;

    const properties: Record<string, unknown> = {
      タイトル: { title: [{ text: { content: article.title.slice(0, 140) } }] },
      記事URL: { url: article.url },
      ソース: { select: { name: mapSourceToNotion(article.source) } },
      判定結果: { select: { name: verdict } },
      概要: { rich_text: [{ text: { content: article.summary || '' } }] },
      処理日: { date: { start: today } },
      収集日: { date: { start: fetchedDate } },
      選出: { checkbox: false },
    };

    if (article.primarySourceUrl) {
      properties['一次ソースURL'] = { url: article.primarySourceUrl };
    }

    if (publishedDate) {
      properties['公開日'] = { date: { start: publishedDate } };
    }

    if (score) {
      properties.novelty = { number: score.novelty };
      properties.impact = { number: score.impact };
      properties.relevance = { number: score.relevance };
      properties['総合スコア'] = { number: score.totalScore };
      properties['選出'] = { checkbox: score.selected };
    }

    try {
      const result = await client.pages.create({
        parent: { database_id: databaseId },
        properties: properties as Parameters<typeof client.pages.create>[0]['properties'],
      });
      createdPageIds.push(result.id);
      saved++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  Notion 書き込み失敗: ${article.title} - ${msg}`);
    }
  }

  // 親DB（処理日一覧）に日付ページを作成/更新
  if (dateDataSourceId && dateDateDatabaseId && createdPageIds.length > 0) {
    await upsertDateEntry(client, dateDataSourceId, dateDateDatabaseId, today, createdPageIds);
  }

  return { saved, skipped };
}

export async function publishContentToPipelineDb(
  client: Client,
  databaseId: string,
  existingPages: Map<string, string>,
  article: Article,
  title: string,
  markdown: string,
): Promise<PublishResult> {
  try {
    const blocks = markdownToBlocks(markdown);
    const pageId = existingPages.get(article.url)
      || (article.primarySourceUrl ? existingPages.get(article.primarySourceUrl) : undefined);

    if (pageId) {
      // 既存ページにコンテンツを追加
      for (let i = 0; i < blocks.length; i += 100) {
        const chunk = blocks.slice(i, i + 100);
        await client.blocks.children.append({
          block_id: pageId,
          children: chunk,
        });
      }
      const notionPageUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;
      return { success: true, articleTitle: title, notionPageUrl };
    } else {
      // 新規ページを作成
      const firstChunk = blocks.slice(0, 100);
      const pageResult = await client.pages.create({
        parent: { database_id: databaseId },
        properties: {
          タイトル: { title: [{ text: { content: title } }] },
        },
        children: firstChunk,
      });
      const newPageId = pageResult.id;

      for (let i = 100; i < blocks.length; i += 100) {
        const chunk = blocks.slice(i, i + 100);
        await client.blocks.children.append({
          block_id: newPageId,
          children: chunk,
        });
      }

      const notionPageUrl = `https://www.notion.so/${newPageId.replace(/-/g, '')}`;
      return { success: true, articleTitle: title, notionPageUrl };
    }
  } catch (error) {
    return { success: false, articleTitle: title, error: String(error) };
  }
}

export async function fetchPublishedTopicsFromNotion(
  client: Client,
  dataSourceId: string,
  daysBack: number = 7,
): Promise<PublishedTopic[]> {
  const sinceDate = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const results: PublishedTopic[] = [];
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        and: [
          { property: '選出', checkbox: { equals: true } },
          { property: '処理日', date: { on_or_after: sinceDate } },
        ],
      },
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const page of response.results) {
      if (!('properties' in page)) continue;
      const props = page.properties as Record<string, unknown>;
      const id = (page as { id: string }).id;

      const titleProp = props['タイトル'];
      const title = (titleProp as any)?.title?.[0]?.plain_text ?? '';

      const dateProp = props['処理日'];
      const publishedAt = (dateProp as any)?.date?.start ?? '';

      const urlProp = props['記事URL'];
      const url = (urlProp as any)?.url ?? '';

      results.push({ id, title, topic: title, publishedAt, url });
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return results;
}

export async function fetchSelectedArticlesFromNotion(
  client: Client,
  dataSourceId: string,
  options?: { date?: string },
): Promise<Article[]> {
  const targetDate = options?.date ?? new Date().toISOString().split('T')[0];
  const results: Article[] = [];
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        and: [
          { property: '選出', checkbox: { equals: true } },
          { property: '処理日', date: { equals: targetDate } },
        ],
      },
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const page of response.results) {
      if (!('properties' in page)) continue;
      results.push(parseArticleFromNotionPage(page as Record<string, unknown>));
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return results;
}

export function parseArticleFromNotionPage(page: Record<string, unknown>): Article {
  const props = page.properties as Record<string, unknown>;
  const id = (page as { id: string }).id;

  const titleProp = props['タイトル'];
  const title = (titleProp as any)?.title?.[0]?.plain_text ?? '';

  const urlProp = props['記事URL'];
  const url = (urlProp as any)?.url ?? '';

  const primarySourceUrlProp = props['一次ソースURL'];
  const primarySourceUrl = (primarySourceUrlProp as any)?.url ?? undefined;

  const sourceProp = props['ソース'];
  const sourceNotionName = (sourceProp as any)?.select?.name ?? '';
  let source: SourceType;
  switch (sourceNotionName) {
    case 'Bluesky': source = 'bluesky'; break;
    case 'Twitter/X': source = 'xsearch'; break;
    case 'HackerNews': source = 'hackernews'; break;
    case 'RSS':
    default: source = 'rss'; break;
  }

  const summaryProp = props['概要'];
  const summary = (summaryProp as any)?.rich_text?.[0]?.plain_text ?? '';

  const publishedAtProp = props['公開日'];
  const publishedAtStr = (publishedAtProp as any)?.date?.start;
  const publishedAt = publishedAtStr ? new Date(publishedAtStr) : undefined;

  const fetchedAtProp = props['収集日'];
  const fetchedAtStr = (fetchedAtProp as any)?.date?.start;
  const fetchedAt = fetchedAtStr ? new Date(fetchedAtStr) : new Date();

  return {
    id, title, url, primarySourceUrl, source,
    sourceName: sourceNotionName, summary, publishedAt, fetchedAt, metadata: {},
  };
}

export async function upsertDateEntry(
  client: Client,
  dateDataSourceId: string,
  dateDatabaseId: string,
  today: string,
  pageIds: string[],
): Promise<void> {
  if (pageIds.length === 0) return;
  const dateLabel = today.replace(/-/g, '/');
  try {
    const dateResponse = await client.dataSources.query({
      data_source_id: dateDataSourceId,
      filter: { property: '日付', title: { equals: dateLabel } },
    });
    const relationValue = pageIds.map(id => ({ id }));
    const RELATION_LIMIT = 100;

    if (dateResponse.results.length > 0) {
      const existingPage = dateResponse.results[0] as { id: string };
      for (let i = 0; i < relationValue.length; i += RELATION_LIMIT) {
        const chunk = relationValue.slice(i, i + RELATION_LIMIT);
        await client.pages.update({
          page_id: existingPage.id,
          properties: { 記事: { relation: chunk } },
        });
      }
    } else {
      const firstChunk = relationValue.slice(0, RELATION_LIMIT);
      const result = await client.pages.create({
        parent: { database_id: dateDatabaseId },
        properties: {
          日付: { title: [{ text: { content: dateLabel } }] },
          記事: { relation: firstChunk },
        },
      });
      for (let i = RELATION_LIMIT; i < relationValue.length; i += RELATION_LIMIT) {
        const chunk = relationValue.slice(i, i + RELATION_LIMIT);
        await client.pages.update({
          page_id: result.id,
          properties: { 記事: { relation: chunk } },
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`  処理日一覧 書き込み失敗: ${msg}`);
  }
}

export async function saveCollectedArticlesToNotion(
  client: Client,
  dataSourceId: string,
  databaseId: string,
  dateDataSourceId: string | undefined,
  dateDatabaseId: string | undefined,
  articles: Article[],
): Promise<{ saved: number; skipped: number }> {
  const existingUrls = await checkDuplicateInDatabase(client, dataSourceId);
  const today = new Date().toISOString().split('T')[0];
  let saved = 0;
  let skipped = 0;
  const createdPageIds: string[] = [];

  for (const article of articles) {
    if (existingUrls.has(article.url) || (article.primarySourceUrl && existingUrls.has(article.primarySourceUrl))) {
      skipped++;
      continue;
    }

    const publishedDate = article.publishedAt
      ? new Date(article.publishedAt).toISOString().split('T')[0]
      : undefined;
    const fetchedDate = article.fetchedAt
      ? new Date(article.fetchedAt).toISOString().split('T')[0]
      : today;

    const properties: Record<string, unknown> = {
      タイトル: { title: [{ text: { content: article.title.slice(0, 140) } }] },
      記事URL: { url: article.url },
      ソース: { select: { name: mapSourceToNotion(article.source) } },
      判定結果: { select: { name: '未処理' } },
      概要: { rich_text: [{ text: { content: article.summary || '' } }] },
      処理日: { date: { start: today } },
      収集日: { date: { start: fetchedDate } },
      選出: { checkbox: false },
    };

    if (article.primarySourceUrl) {
      properties['一次ソースURL'] = { url: article.primarySourceUrl };
    }
    if (publishedDate) {
      properties['公開日'] = { date: { start: publishedDate } };
    }

    try {
      const result = await client.pages.create({
        parent: { database_id: databaseId },
        properties: properties as Parameters<typeof client.pages.create>[0]['properties'],
      });
      createdPageIds.push(result.id);
      saved++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  Notion 書き込み失敗: ${article.title} - ${msg}`);
    }
  }

  if (dateDataSourceId && dateDatabaseId) {
    await upsertDateEntry(client, dateDataSourceId, dateDatabaseId, today, createdPageIds);
  }

  return { saved, skipped };
}

export async function fetchUnprocessedArticlesFromNotion(
  client: Client,
  dataSourceId: string,
  options?: { date?: string },
): Promise<Article[]> {
  const targetDate = options?.date ?? new Date().toISOString().split('T')[0];
  const results: Article[] = [];
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        and: [
          { property: '判定結果', select: { equals: '未処理' } },
          { property: '処理日', date: { equals: targetDate } },
        ],
      },
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const page of response.results) {
      if (!('properties' in page)) continue;
      results.push(parseArticleFromNotionPage(page as Record<string, unknown>));
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return results;
}

export async function updateArticleSelectionsInNotion(
  client: Client,
  verified: Article[],
  rejected: { article: Article; reason: string }[],
  scores: SelectionScore[],
): Promise<{ updated: number; errors: number }> {
  const scoreMap = new Map(scores.map(s => [s.id, s]));
  let updated = 0;
  let errors = 0;

  for (const article of verified) {
    const score = scoreMap.get(article.id);
    const properties: Record<string, unknown> = {
      判定結果: { select: { name: '合格' } },
    };
    if (score) {
      properties.novelty = { number: score.novelty };
      properties.impact = { number: score.impact };
      properties.relevance = { number: score.relevance };
      properties['総合スコア'] = { number: score.totalScore };
      properties['選出'] = { checkbox: score.selected };
    }
    try {
      await client.pages.update({
        page_id: article.id,
        properties: properties as Parameters<typeof client.pages.update>[0]['properties'],
      });
      updated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  Notion 更新失敗: ${article.title} - ${msg}`);
      errors++;
    }
  }

  for (const { article } of rejected) {
    try {
      await client.pages.update({
        page_id: article.id,
        properties: {
          判定結果: { select: { name: '除外' } },
        } as Parameters<typeof client.pages.update>[0]['properties'],
      });
      updated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  Notion 更新失敗: ${article.title} - ${msg}`);
      errors++;
    }
  }

  return { updated, errors };
}
