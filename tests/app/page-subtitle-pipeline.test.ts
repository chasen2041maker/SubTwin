import { describe, expect, it } from 'vitest';

import {
  advancePageSubtitlePipeline,
  createPageSubtitlePipeline,
} from '../../src/app/page-subtitle-pipeline';

describe('page subtitle pipeline', () => {
  it('advances through catalog, metadata, resource, and approval diagnostics', () => {
    const bridgeGeneration = 2;
    const episodeGeneration = 1;
    const catalog = advancePageSubtitlePipeline(
      createPageSubtitlePipeline(bridgeGeneration, episodeGeneration),
      {
        bridgeGeneration,
        episodeGeneration,
        stage: 'catalog',
        message: '目录已读取',
      },
    );
    const metadata = advancePageSubtitlePipeline(catalog, {
      bridgeGeneration,
      episodeGeneration,
      stage: 'metadata',
      message: '元数据已解析',
    });
    const resources = advancePageSubtitlePipeline(metadata, {
      bridgeGeneration,
      episodeGeneration,
      stage: 'resources',
      message: '已提取字幕资源',
    });
    const approved = advancePageSubtitlePipeline(resources, {
      bridgeGeneration,
      episodeGeneration,
      stage: 'approved',
      message: '字幕资源已匹配',
    });

    expect(approved).toEqual({
      bridgeGeneration,
      episodeGeneration,
      stage: 'approved',
      message: '字幕资源已匹配',
    });
  });

  it('never lets duplicate or late events downgrade a parsed pipeline', () => {
    const accepted = {
      bridgeGeneration: 4,
      episodeGeneration: 2,
      stage: 'accepted' as const,
      message: '字幕已解析，可显示双语',
    };

    expect(advancePageSubtitlePipeline(accepted, {
      bridgeGeneration: 4,
      episodeGeneration: 2,
      stage: 'received',
      message: '字幕正文已到达',
    })).toBe(accepted);
    expect(advancePageSubtitlePipeline(accepted, {
      bridgeGeneration: 3,
      episodeGeneration: 99,
      stage: 'failed',
      message: '旧一代失败',
    })).toBe(accepted);
  });

  it('recovers from a partial failure when both tracks are later accepted', () => {
    const failed = {
      bridgeGeneration: 5,
      episodeGeneration: 1,
      stage: 'failed' as const,
      message: '字幕解析失败',
    };
    expect(advancePageSubtitlePipeline(failed, {
      bridgeGeneration: 5,
      episodeGeneration: 1,
      stage: 'accepted',
      message: '字幕已解析，可显示双语',
    })).toEqual({
      bridgeGeneration: 5,
      episodeGeneration: 1,
      stage: 'accepted',
      message: '字幕已解析，可显示双语',
    });
  });

  it('recovers from a failure when one usable track is later accepted', () => {
    const failed = {
      bridgeGeneration: 5,
      episodeGeneration: 1,
      stage: 'failed' as const,
      message: '字幕解析失败',
    };

    expect(advancePageSubtitlePipeline(failed, {
      bridgeGeneration: 5,
      episodeGeneration: 1,
      stage: 'partial',
      message: '已解析一条字幕轨，等待另一条',
    })).toEqual({
      bridgeGeneration: 5,
      episodeGeneration: 1,
      stage: 'partial',
      message: '已解析一条字幕轨，等待另一条',
    });
  });

  it('starts a fresh catalog stage when the content-session generation changes', () => {
    const accepted = {
      bridgeGeneration: 8,
      episodeGeneration: 1,
      stage: 'accepted',
      message: '字幕已解析，可显示双语',
    } as const;
    const waiting = advancePageSubtitlePipeline(
      accepted,
      createPageSubtitlePipeline(8, 2),
    );
    const catalog = advancePageSubtitlePipeline(waiting, {
      bridgeGeneration: 8,
      episodeGeneration: 2,
      stage: 'catalog',
      message: '已读取 Netflix 字幕目录',
    });

    expect(catalog).toEqual({
      bridgeGeneration: 8,
      episodeGeneration: 2,
      stage: 'catalog',
      message: '已读取 Netflix 字幕目录',
    });
    expect(advancePageSubtitlePipeline(catalog, accepted)).toBe(catalog);
  });

  it('explicitly resets when a newer bridge generation starts', () => {
    const current = {
      bridgeGeneration: 8,
      episodeGeneration: 3,
      stage: 'accepted' as const,
      message: '字幕已解析，可显示双语',
    };
    expect(advancePageSubtitlePipeline(
      current,
      createPageSubtitlePipeline(9, 0),
    )).toEqual({
      bridgeGeneration: 9,
      episodeGeneration: 0,
      stage: 'waiting',
      message: '等待字幕数据',
    });
  });
});
