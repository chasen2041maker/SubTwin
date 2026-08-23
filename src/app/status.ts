export const RUNTIME_STATUS_STORAGE_KEY = 'subtwinRuntimeStatus' as const;

export type RuntimeMode =
  | 'deepseek'
  | 'discovering'
  | 'error'
  | 'google-free'
  | 'official'
  | 'unset';

export type RuntimeErrorCode =
  | 'authentication_failed'
  | 'insufficient_balance'
  | 'invalid_configuration'
  | 'missing_english'
  | 'netflix_unavailable'
  | 'offline'
  | 'provider_forbidden'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'timeout';

export type RuntimeStatus =
  | { readonly mode: Exclude<RuntimeMode, 'error'> }
  | { readonly mode: 'error'; readonly code: RuntimeErrorCode };

const ERROR_MESSAGES: Readonly<Record<RuntimeErrorCode, string>> = {
  authentication_failed: 'DeepSeek 认证失败，请在设置中检查 API Key。',
  insufficient_balance: 'DeepSeek 账户余额不足，英文或 Netflix 原生字幕仍可继续使用。',
  invalid_configuration: '翻译配置不完整，请打开设置页检查。',
  missing_english: '当前影片没有可用的英文字幕轨道。',
  netflix_unavailable: '暂时无法读取 Netflix 字幕，播放不会受到影响。',
  offline: '当前网络不可用，已保留英文或 Netflix 原生字幕。',
  provider_forbidden: '翻译服务拒绝了请求，请检查服务设置。',
  provider_unavailable: '翻译服务暂时不可用，请稍后重试。',
  rate_limited: '翻译请求过快，SubTwin 会稍后再试。',
  timeout: '翻译服务响应超时，英文字幕仍可继续使用。',
};

const MODE_MESSAGES: Readonly<Record<Exclude<RuntimeMode, 'error'>, string>> = {
  deepseek: '官方中文字幕缺失，正在使用 DeepSeek 上下文翻译。',
  discovering: '正在确认 Netflix 官方字幕轨道；确认前不会调用外部翻译。',
  'google-free': '官方中文字幕缺失，正在使用实验性的 Google 免费翻译。',
  official: '已发现 Netflix 官方英文与简体中文字幕，不会调用外部翻译。',
  unset: '尚未选择翻译方式，任何字幕都不会发送给外部服务。',
};

const ERROR_CODES = new Set<RuntimeErrorCode>(
  Object.keys(ERROR_MESSAGES) as RuntimeErrorCode[],
);
const NON_ERROR_MODES = new Set<Exclude<RuntimeMode, 'error'>>([
  'deepseek',
  'discovering',
  'google-free',
  'official',
  'unset',
]);

export function parseRuntimeStatus(value: unknown): RuntimeStatus | null {
  if (!isRecord(value) || typeof value.mode !== 'string') return null;
  if (value.mode === 'error') {
    if (
      !hasExactlyKeys(value, ['code', 'mode']) ||
      typeof value.code !== 'string' ||
      !ERROR_CODES.has(value.code as RuntimeErrorCode)
    ) return null;
    return { mode: 'error', code: value.code as RuntimeErrorCode };
  }
  if (
    !hasExactlyKeys(value, ['mode']) ||
    !NON_ERROR_MODES.has(value.mode as Exclude<RuntimeMode, 'error'>)
  ) return null;
  return { mode: value.mode as Exclude<RuntimeMode, 'error'> };
}

export function runtimeStatusMessage(status: RuntimeStatus): string {
  return status.mode === 'error'
    ? ERROR_MESSAGES[status.code]
    : MODE_MESSAGES[status.mode];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}
