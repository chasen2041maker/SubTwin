import { normalizeNetflixLanguageTag } from './adapter';
import type {
  NetflixCatalogPayload,
  NetflixTimedTextPayload,
} from './bridge';

export interface NetflixCatalogTimedTextBinding {
  readonly titleId: string;
  readonly trackId: string;
  /** 仅供 MAIN world 区分文本格式，不跨桥传递 Netflix 原始配置名称。 */
  readonly variantId?: string;
}

/** 请求绑定只在 MAIN world 内流转，发送字幕前必须剥离。 */
export interface NetflixObservedTimedTextPayload {
  readonly type: 'timed-text';
  readonly resourceId: string;
  readonly trackId: string;
  readonly language: string;
  readonly format: 'ttml' | 'webvtt';
  readonly body: string;
  readonly requestBinding?: NetflixCatalogTimedTextBinding;
}

export interface NetflixTimedTextRequestObservation {
  readonly resourceId: string;
  readonly binding: NetflixCatalogTimedTextBinding;
}

const MAX_REQUEST_BINDINGS = 128;

/**
 * 按不含签名 URL 的资源身份保存请求时的归属；冲突和跨集结果不能降级为语言猜测。
 * 返回的 bind 方法仅产出桥接白名单字段，无法确定轨道时返回 null。
 */
export function createNetflixTimedTextRequestBindings() {
  const requests = new Map<string, NetflixCatalogTimedTextBinding | null>();
  return {
    remember({ resourceId, binding }: NetflixTimedTextRequestObservation): void {
      const previous = requests.get(resourceId);
      if (requests.has(resourceId) && (
        previous === null || previous?.titleId !== binding.titleId ||
        previous.trackId !== binding.trackId
      )) {
        requests.set(resourceId, null);
        return;
      }
      if (requests.size >= MAX_REQUEST_BINDINGS && !requests.has(resourceId)) {
        const oldest = requests.keys().next().value;
        if (oldest !== undefined) requests.delete(oldest);
      }
      requests.set(resourceId, Object.freeze({ ...binding }));
    },

    bind(
      payload: NetflixObservedTimedTextPayload,
      catalog: NetflixCatalogPayload,
    ): NetflixTimedTextPayload | null {
      const binding = payload.requestBinding ?? requests.get(payload.resourceId);
      if (binding === null || (binding !== undefined && binding.titleId !== catalog.titleId)) {
        return null;
      }
      const embedded = extractNetflixTimedTextEmbeddedLanguage(payload.body, payload.format);
      const language = normalizeNetflixLanguageTag(embedded ?? payload.language);
      const matches = binding === undefined
        ? catalog.tracks.filter((track) =>
          sameLanguage(track.language, language?.sourceTag))
        : catalog.tracks.filter((track) => track.id === binding.trackId);
      if (matches.length !== 1) return null;
      const track = matches[0];
      if (track === undefined || (language !== null && payload.language !== 'und' &&
        !sameLanguage(track.language, language.sourceTag)) ||
        (embedded !== null && !sameLanguage(track.language, embedded))) return null;
      return {
        type: 'timed-text', titleId: catalog.titleId,
        resourceId: payload.resourceId, trackId: track.id, language: track.language,
        format: payload.format, body: payload.body,
      };
    },

    clear(): void { requests.clear(); },
  };
}

function sameLanguage(left: string, right: string | undefined): boolean {
  return right !== undefined && normalizeNetflixLanguageTag(left)?.sourceTag.toLowerCase() ===
    right.toLowerCase();
}

/** 只接受 TTML 根节点上唯一、格式受限的 xml:lang；WebVTT 不推断语言。 */
export function extractNetflixTimedTextEmbeddedLanguage(
  body: string,
  format: 'ttml' | 'webvtt',
): string | null {
  if (format !== 'ttml') return null;
  const prefix = body.replace(/^\uFEFF/u, '').trimStart().slice(0, 8_192);
  const root = /^(?:<\?xml[^>]*>\s*)?<(?:[A-Za-z][\w.-]*:)?tt\b([^>]*)>/iu.exec(prefix);
  if (root === null) return null;
  const attributes = root[1] ?? '';
  const languages = [...attributes.matchAll(
    /(?:^|\s)xml:lang\s*=\s*(["'])([^"']+)\1/giu,
  )].map((match) => match[2]?.trim().replaceAll('_', '-'));
  const language = languages.length === 1 ? languages[0] : undefined;
  return language !== undefined && language.length <= 35 &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language) ? language : null;
}
