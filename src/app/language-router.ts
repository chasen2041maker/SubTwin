import type {
  SubtitleCatalogAuthority,
  SubtitleSchedulingScope,
} from '../subtitles/source';
import type {
  TranslationProviderId,
  TranslationProviderSelection,
} from '../translation/types';

export type LanguageRouteMode =
  | 'chinese-original'
  | 'deepseek'
  | 'disabled'
  | 'discovering'
  | 'google-free'
  | 'missing-English'
  | 'missing-key'
  | 'official'
  | 'provider-unset';

export type LanguageRouteSourceMode =
  | 'external-translation'
  | 'native-only'
  | 'official-alignment';

export interface LanguageRoutingInput {
  readonly enabled: boolean;
  readonly catalogAuthority: SubtitleCatalogAuthority;
  readonly englishAvailable: boolean;
  readonly simplifiedChineseAvailable: boolean;
  readonly provider: TranslationProviderSelection;
  readonly deepseekKeyReady: boolean;
  readonly schedulingScope: SubtitleSchedulingScope;
  /** 权威目录确认影片原声为华语：保留 Netflix 原字幕，SubTwin 完全不处理。 */
  readonly chineseOriginal?: boolean;
}

export interface LanguageRoute {
  readonly mode: LanguageRouteMode;
  readonly externalCallsAllowed: boolean;
  readonly provider: TranslationProviderId | null;
  readonly schedulingScope: SubtitleSchedulingScope;
  readonly sourceMode: LanguageRouteSourceMode;
}

export function routeLanguages(input: LanguageRoutingInput): LanguageRoute {
  if (!input.enabled) return nativeOnly('disabled');
  if (input.chineseOriginal === true) return nativeOnly('chinese-original');
  if (input.catalogAuthority !== 'authoritative') {
    return nativeOnly('discovering');
  }
  if (!input.englishAvailable) return nativeOnly('missing-English');
  if (input.provider === 'unset') {
    return input.simplifiedChineseAvailable
      ? nativeOnly('official', 'official-alignment')
      : nativeOnly('provider-unset');
  }
  if (input.provider === 'deepseek' && !input.deepseekKeyReady) {
    return nativeOnly('missing-key');
  }

  return {
    mode: input.provider,
    externalCallsAllowed: true,
    provider: input.provider,
    schedulingScope: input.schedulingScope,
    sourceMode: 'external-translation',
  };
}

function nativeOnly(
  mode: Exclude<LanguageRouteMode, TranslationProviderId>,
  sourceMode: LanguageRouteSourceMode = 'native-only',
): LanguageRoute {
  return {
    mode,
    externalCallsAllowed: false,
    provider: null,
    schedulingScope: 'none',
    sourceMode,
  };
}
