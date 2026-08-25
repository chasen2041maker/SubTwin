import type { NetflixContentCatalogSummary } from '../app/netflix-content-session';
import type {
  PageCatalogSummary,
  PagePlaybackMetadata,
} from '../renderer/PageControlSurface';
import { normalizeNetflixLanguageTag } from './adapter';

const TITLE_SELECTORS = [
  '[data-uia="video-title"]',
  '[data-uia="player-title"]',
  '.video-title h4',
] as const;
const AUDIO_SELECTOR = '[data-uia^="audio-item-selected-"]';
const SUBTITLE_SELECTOR = '[data-uia^="subtitle-item-selected-"]';

export interface PageMetadataElement {
  readonly textContent: string | null;
  readonly paused?: boolean | undefined;
  getAttribute(name: string): string | null;
}

export interface PageMetadataDocument {
  readonly title: string;
  querySelector(selector: string): PageMetadataElement | null;
}

export function readNetflixPageMetadata(
  document: PageMetadataDocument,
): PagePlaybackMetadata {
  const video = document.querySelector('video');
  return {
    title: readTitle(document),
    playback: video === null || typeof video.paused !== 'boolean'
      ? 'unavailable'
      : video.paused ? 'paused' : 'playing',
    audioTrack: readSelectedTrack(
      document,
      AUDIO_SELECTOR,
      'audio-item-selected-',
      '等待 Netflix 音轨信息',
    ),
    subtitleTrack: readSelectedTrack(
      document,
      SUBTITLE_SELECTOR,
      'subtitle-item-selected-',
      '等待 Netflix 字幕轨信息',
    ),
  };
}

export function summarizeNetflixCatalog(
  summary: NetflixContentCatalogSummary | null,
): PageCatalogSummary {
  if (summary === null) {
    return {
      authority: 'unknown',
      englishTrack: '等待 Netflix 字幕目录',
      chineseTrack: '等待 Netflix 字幕目录',
      officialChinese: false,
    };
  }
  const english = summary.tracks.find(
    ({ language }) => normalizeNetflixLanguageTag(language)?.category === 'english',
  );
  const chinese = summary.tracks.find(
    ({ language }) =>
      normalizeNetflixLanguageTag(language)?.category === 'simplified-chinese',
  );
  return {
    authority: summary.authority,
    englishTrack: english === undefined
      ? '未发现英文字幕'
      : `${english.language} · ${english.kind}`,
    chineseTrack: chinese === undefined
      ? '未发现简体中文字幕'
      : `${chinese.language} · ${chinese.kind}`,
    officialChinese: summary.authority === 'authoritative' && chinese !== undefined,
  };
}

function readTitle(document: PageMetadataDocument): string {
  for (const selector of TITLE_SELECTORS) {
    const value = cleanText(document.querySelector(selector)?.textContent);
    if (value !== null) return value;
  }
  const fallback = cleanText(document.title
    .replace(/\s*(?:—|-|\|)\s*Netflix\s*$/iu, '')
    .replace(/^Netflix\s*(?:—|-|\|)\s*/iu, ''));
  return fallback === null || fallback.toLowerCase() === 'netflix'
    ? '等待 Netflix 影片'
    : fallback;
}

function readSelectedTrack(
  document: PageMetadataDocument,
  selector: string,
  dataPrefix: string,
  fallback: string,
): string {
  const selected = document.querySelector(selector);
  if (selected === null) return fallback;
  const text = cleanText(selected.textContent);
  if (text !== null) return text;
  const dataUia = selected.getAttribute('data-uia');
  if (dataUia === null || !dataUia.startsWith(dataPrefix)) return fallback;
  return cleanText(dataUia.slice(dataPrefix.length)) ?? fallback;
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 160);
}
