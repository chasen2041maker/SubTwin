import type { SubtitleLanguage } from './types';

export type SubtitleCatalogAuthority = 'authoritative' | 'provisional';

export type SubtitleSourceTrackLifecycle =
  | 'confirmed'
  | 'disposed'
  | 'provisional';

export type SubtitleSchedulingScope = 'bulk' | 'none' | 'urgent-window';

export interface SubtitleSourceCatalogTrack {
  readonly trackId: string;
  readonly language: SubtitleLanguage;
}

export interface SubtitleSourceCatalog {
  readonly authority: SubtitleCatalogAuthority;
  readonly tracks: readonly SubtitleSourceCatalogTrack[];
}

export interface SubtitleSourceTrack extends SubtitleSourceCatalogTrack {
  readonly active: boolean;
  readonly lifecycle: SubtitleSourceTrackLifecycle;
}

export interface SubtitleSourceSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly contentId: string;
  readonly mountId: string;
}

export interface SubtitleSourceState {
  readonly session: SubtitleSourceSession;
  readonly catalog: SubtitleSourceCatalog;
  readonly tracks: readonly SubtitleSourceTrack[];
  readonly externalTranslationAllowed: boolean;
  readonly schedulingScope: SubtitleSchedulingScope;
}
