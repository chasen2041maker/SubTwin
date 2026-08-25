import { describe, expect, it } from 'vitest';

import {
  readNetflixPageMetadata,
  summarizeNetflixCatalog,
  type PageMetadataDocument,
  type PageMetadataElement,
} from '../../src/netflix/page-metadata';

class ElementFixture implements PageMetadataElement {
  constructor(
    readonly textContent: string | null,
    private readonly attributes: Readonly<Record<string, string>> = {},
    readonly paused?: boolean,
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

class DocumentFixture implements PageMetadataDocument {
  constructor(
    readonly title: string,
    private readonly matches: Readonly<Record<string, PageMetadataElement>>,
  ) {}

  querySelector(selector: string): PageMetadataElement | null {
    return this.matches[selector] ?? null;
  }
}

describe('Netflix page metadata', () => {
  it('reads accessible selected tracks and playback state without private page data', () => {
    const document = new DocumentFixture('《纸牌屋》— Netflix', {
      '[data-uia="video-title"]': new ElementFixture('  纸牌屋  '),
      '[data-uia^="audio-item-selected-"]': new ElementFixture('英语 [原始]'),
      '[data-uia^="subtitle-item-selected-"]': new ElementFixture('英语 (CC)'),
      video: new ElementFixture(null, {}, false),
    });

    expect(readNetflixPageMetadata(document)).toEqual({
      title: '纸牌屋',
      playback: 'playing',
      audioTrack: '英语 [原始]',
      subtitleTrack: '英语 (CC)',
    });
  });

  it('falls back to sanitized title and data-uia labels when menu text is unavailable', () => {
    const document = new DocumentFixture('\u0000怪奇物语 | Netflix', {
      '[data-uia^="audio-item-selected-"]': new ElementFixture('', {
        'data-uia': 'audio-item-selected-English [Original]',
      }),
      '[data-uia^="subtitle-item-selected-"]': new ElementFixture(null, {
        'data-uia': 'subtitle-item-selected-中文（简体）',
      }),
      video: new ElementFixture(null, {}, true),
    });

    expect(readNetflixPageMetadata(document)).toEqual({
      title: '怪奇物语',
      playback: 'paused',
      audioTrack: 'English [Original]',
      subtitleTrack: '中文（简体）',
    });
  });

  it('uses explicit waiting labels instead of inventing unavailable tracks', () => {
    expect(readNetflixPageMetadata(new DocumentFixture('Netflix', {}))).toEqual({
      title: '等待 Netflix 影片',
      playback: 'unavailable',
      audioTrack: '等待 Netflix 音轨信息',
      subtitleTrack: '等待 Netflix 字幕轨信息',
    });
  });

  it('summarizes only safe catalog language and kind fields for the control panel', () => {
    expect(summarizeNetflixCatalog({
      sessionId: 'session-private-id',
      generation: 4,
      authority: 'authoritative',
      tracks: [
        { id: 'secret-track-id', language: 'en-US', kind: 'closed-caption' },
        { id: 'secret-zh-id', language: 'zh-Hans', kind: 'subtitle' },
      ],
    })).toEqual({
      authority: 'authoritative',
      englishTrack: 'en-US · closed-caption',
      chineseTrack: 'zh-Hans · subtitle',
      officialChinese: true,
    });
    expect(JSON.stringify(summarizeNetflixCatalog(null))).not.toContain('session');
  });
});
