import { createHash } from 'node:crypto';
import type { Article } from './types.js';

export const XSEARCH_RESPONSE_SCHEMA = {
  type: 'json_schema' as const,
  name: 'x_search_results',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            text: { type: 'string' },
            url: { type: 'string' },
            external_url: { type: ['string', 'null'] },
            like_count: { type: ['number', 'null'] },
            posted_at: { type: ['string', 'null'] },
          },
          required: ['username', 'text', 'url', 'external_url', 'like_count', 'posted_at'],
          additionalProperties: false,
        },
      },
    },
    required: ['posts'],
    additionalProperties: false,
  },
};

// x_search の structured output で期待する投稿データの型
interface XSearchPost {
  username: string;
  text: string;
  url: string;
  external_url?: string;
  like_count?: number;
  posted_at?: string;
}

// Responses API のレスポンスから output_text を抽出
export function extractOutputText(response: Record<string, unknown>): string | null {
  const output = response.output as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (item.type === 'message') {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'output_text' && typeof block.text === 'string') {
          return block.text;
        }
      }
    }
  }
  return null;
}

// citations から URL を抽出するフォールバック
export function extractCitationUrls(response: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const output = response.output as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(output)) return urls;

  for (const item of output) {
    if (item.type === 'message') {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'output_text') {
          const annotations = block.annotations as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(annotations)) continue;
          for (const ann of annotations) {
            if (ann.type === 'url_citation' && typeof ann.url === 'string') {
              // x.com/twitter.com のツイートURLだけ収集
              if (/https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/.test(ann.url)) {
                urls.push(ann.url);
              }
            }
          }
        }
      }
    }
  }
  return [...new Set(urls)];
}

function generateId(url: string): string {
  return 'xsearch-' + createHash('sha256').update(url).digest('hex').slice(0, 16);
}

// JSON テキスト → Article[] 変換
export function parseXSearchPosts(jsonText: string): Article[] {
  let posts: XSearchPost[];
  try {
    const parsed = JSON.parse(jsonText);
    posts = Array.isArray(parsed) ? parsed : parsed.posts ?? parsed.results ?? [];
  } catch {
    return [];
  }

  const now = new Date();
  return posts
    .filter((p): p is XSearchPost => typeof p.url === 'string' && typeof p.text === 'string')
    .map((post) => ({
      id: generateId(post.url),
      title: post.text.slice(0, 140),
      url: post.external_url ?? post.url,
      primarySourceUrl: post.external_url,
      source: 'xsearch' as const,
      sourceName: `X (@${post.username})`,
      summary: post.text,
      publishedAt: post.posted_at ? new Date(post.posted_at) : undefined,
      fetchedAt: now,
      metadata: {
        via: 'xsearch',
        username: post.username,
        tweetUrl: post.url,
        likeCount: post.like_count,
      },
    }));
}

// メインのパース関数 — structured output → フォールバック（citations）
export function parseXSearchResponse(response: Record<string, unknown>): Article[] {
  // 1. structured output からパース試行
  const text = extractOutputText(response);
  if (text) {
    const articles = parseXSearchPosts(text);
    if (articles.length > 0) return articles;
  }

  // 2. フォールバック: citations から URL だけ抽出
  const urls = extractCitationUrls(response);
  const now = new Date();
  return urls.map((url) => ({
    id: generateId(url),
    title: url,
    url,
    source: 'xsearch' as const,
    sourceName: 'X (via xsearch)',
    fetchedAt: now,
    metadata: { via: 'xsearch' },
  }));
}
