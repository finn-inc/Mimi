import type { Article } from '../../sources/types.js';

export interface StageOutput {
  articleId: string;
  stage: 'knowledge' | 'summary' | 'tweet';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AudienceConfig {
  name: string;
  description: string;
  maxLength: number;
}

export interface PipelineConfig {
  stages: ('knowledge' | 'summary' | 'tweet')[];
  summary: {
    audiences: AudienceConfig[];
    rounds: number;
  };
  tweet: {
    maxChars: number;
    includeHashtags: boolean;
    hashtagCount: number;
  };
}

export interface PipelineResult {
  articleId: string;
  title: string;
  knowledge?: StageOutput;
  summaries?: StageOutput[];
  tweet?: StageOutput;
}
