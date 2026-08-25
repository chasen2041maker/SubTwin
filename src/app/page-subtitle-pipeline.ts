export type PageSubtitlePipelineStage =
  | 'accepted'
  | 'approved'
  | 'catalog'
  | 'downloaded'
  | 'downloading'
  | 'failed'
  | 'metadata'
  | 'partial'
  | 'received'
  | 'resources'
  | 'waiting';

export interface PageSubtitlePipelineState {
  readonly bridgeGeneration: number;
  readonly episodeGeneration: number;
  readonly stage: PageSubtitlePipelineStage;
  readonly message: string;
}

const STAGE_RANK: Readonly<Record<PageSubtitlePipelineStage, number>> = {
  waiting: 0,
  catalog: 1,
  metadata: 2,
  resources: 3,
  approved: 4,
  downloading: 5,
  downloaded: 6,
  received: 7,
  failed: 8,
  partial: 9,
  accepted: 10,
};

export function createPageSubtitlePipeline(
  bridgeGeneration: number,
  episodeGeneration = 0,
): PageSubtitlePipelineState {
  return {
    bridgeGeneration,
    episodeGeneration,
    stage: 'waiting',
    message: '等待字幕数据',
  };
}

export function advancePageSubtitlePipeline(
  current: PageSubtitlePipelineState,
  next: PageSubtitlePipelineState,
): PageSubtitlePipelineState {
  if (next.bridgeGeneration < current.bridgeGeneration) return current;
  if (next.bridgeGeneration > current.bridgeGeneration) return next;
  if (next.episodeGeneration < current.episodeGeneration) return current;
  if (next.episodeGeneration > current.episodeGeneration) return next;
  return STAGE_RANK[next.stage] >= STAGE_RANK[current.stage]
    ? next
    : current;
}
