import { Client } from '@notionhq/client';
import { markdownToBlocks } from './markdown-to-blocks.js';
import type { PublishResult } from './types.js';
import { createNotionClient } from './client.js';

export interface NotionContext {
  client: Client;
  datePage: { id: string; url: string };
  firstBlockId?: string;
}

export async function initNotionContext(
  notionConfig: { tokenEnvVar?: string; collectionDbId: string },
): Promise<NotionContext | null> {
  try {
    const client = createNotionClient(notionConfig.tokenEnvVar);
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');
    const datePage = await findDatePage(client, notionConfig.collectionDbId, today);
    if (datePage) {
      console.log(`Notion 日付ページを検出: ${today}`);
      // N+1修正: firstBlockId をここで1回だけ取得
      const listResult = await client.blocks.children.list({
        block_id: datePage.id,
        page_size: 1,
      });
      const firstBlockId = listResult.results[0]?.id;
      return { client, datePage, firstBlockId };
    } else {
      console.warn(`Notion に ${today} の日付ページが見つかりません。コンソール出力にフォールバックします。`);
      return null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Notion 初期化エラー: ${msg}`);
    console.warn('コンソール出力にフォールバックします。');
    return null;
  }
}

export async function findDatePage(
  client: Client,
  collectionDbId: string,
  date: string,
): Promise<{ id: string; url: string } | null> {
  const response = await client.dataSources.query({
    data_source_id: collectionDbId,
    filter: {
      property: '日付',
      title: {
        equals: date,
      },
    },
  });

  if (response.results.length === 0) {
    return null;
  }

  const page = response.results[0] as { id: string; url: string };
  return { id: page.id, url: page.url };
}

export async function checkDuplicateInDatabase(
  client: Client,
  dataSourceId: string,
): Promise<Set<string>> {
  const existingUrls = new Set<string>();
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
      const props = page.properties as Record<string, unknown>;
      // URL プロパティを探す（"userDefined:URL" または "URL"）
      for (const prop of Object.values(props)) {
        if (prop && typeof prop === 'object' && 'type' in prop && (prop as Record<string, unknown>).type === 'url') {
          const urlValue = (prop as Record<string, unknown>).url;
          if (typeof urlValue === 'string' && urlValue) {
            existingUrls.add(urlValue);
          }
        }
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return existingUrls;
}

export async function publishArticleToDatabase(
  client: Client,
  databaseId: string,
  title: string,
  markdown: string,
): Promise<PublishResult> {
  try {
    // Step 1: Convert markdown to Notion blocks
    const blocks = markdownToBlocks(markdown);

    // Step 2: Create a database page with properties and first 100 blocks
    const firstChunk = blocks.slice(0, 100);
    const pageResult = await client.pages.create({
      parent: { database_id: databaseId },
      properties: {
        タイトル: { title: [{ text: { content: title } }] },
        ライター: { select: { name: 'Mimi(速報)' } },
        ステータス: { select: { name: '未着手' } },
      },
      children: firstChunk,
    });
    const newPageId = pageResult.id;

    // Step 3: Append remaining content blocks in chunks of 100
    for (let i = 100; i < blocks.length; i += 100) {
      const chunk = blocks.slice(i, i + 100);
      await client.blocks.children.append({
        block_id: newPageId,
        children: chunk,
      });
    }

    // Step 4: Construct Notion page URL
    const notionPageUrl = `https://www.notion.so/${newPageId.replace(/-/g, '')}`;

    return { success: true, articleTitle: title, notionPageUrl };
  } catch (error) {
    return { success: false, articleTitle: title, error: String(error) };
  }
}

export async function publishArticleToNotion(
  client: Client,
  datePageId: string,
  title: string,
  markdown: string,
  firstBlockId?: string,
): Promise<PublishResult> {
  try {
    // Step 1: Convert markdown to Notion blocks
    const blocks = markdownToBlocks(markdown);

    // Step 2: Create a child page with content, positioned after the first block (if present)
    const firstChunk = blocks.slice(0, 100);
    const createOptions: Parameters<typeof client.pages.create>[0] = {
      parent: { page_id: datePageId },
      properties: {
        title: { title: [{ text: { content: title } }] },
      },
      content: firstChunk,
    };

    if (firstBlockId) {
      (createOptions as Record<string, unknown>).position = {
        type: 'after_block',
        after_block: { id: firstBlockId },
      };
    }

    const pageResult = await client.pages.create(createOptions);
    const newPageId = pageResult.id;

    // Step 3: Append remaining content blocks in chunks of 100
    for (let i = 100; i < blocks.length; i += 100) {
      const chunk = blocks.slice(i, i + 100);
      await client.blocks.children.append({
        block_id: newPageId,
        children: chunk,
      });
    }

    // Step 4: Construct Notion page URL
    const notionPageUrl = `https://www.notion.so/${newPageId.replace(/-/g, '')}`;

    return { success: true, articleTitle: title, notionPageUrl };
  } catch (error) {
    return { success: false, articleTitle: title, error: String(error) };
  }
}
