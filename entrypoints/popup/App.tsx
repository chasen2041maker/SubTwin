import { useEffect, useState, type ReactNode } from 'react';

import {
  RUNTIME_STATUS_STORAGE_KEY,
  parseRuntimeStatus,
  runtimeStatusMessage,
  type RuntimeMode,
  type RuntimeStatus,
} from '../../src/app/status';
import { createMessage } from '../../src/shared/messages';
import {
  parseEnabledSetActionResponse,
  parsePublicSettingsActionResponse,
} from '../../src/storage/action-client';
import type { TranslationProviderSetting } from '../../src/storage/schema';

interface PopupSettings {
  readonly enabled: boolean;
  readonly provider: TranslationProviderSetting;
}

type StatusTone = 'active' | 'error' | 'idle' | 'pending';

interface DisplayStatus {
  readonly title: string;
  readonly body: string;
  readonly tone: StatusTone;
}

const SOURCE_LABELS: Readonly<Record<TranslationProviderSetting, {
  readonly name: string;
  readonly detail: string;
}>> = {
  unset: { name: 'Netflix 原生双语', detail: '只用官方中英字幕，不调用翻译' },
  'google-free': { name: 'Google 翻译', detail: '免 Key · 实验性接口' },
  deepseek: { name: 'DeepSeek', detail: '上下文翻译 · 自备 Key' },
};

const TITLE_BY_MODE: Readonly<Record<RuntimeMode, string>> = {
  'chinese-original': '华语原声影片',
  deepseek: 'DeepSeek 翻译中',
  discovering: '正在识别当前影片',
  error: '需要处理',
  'google-free': 'Google 翻译中',
  official: '官方双语',
  unset: '等待设置',
};

export default function App() {
  const [settings, setSettings] = useState<PopupSettings | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const request = createPublicSettingsRequest();
        const [settingsResponse, storedStatus] = await Promise.all([
          browser.runtime.sendMessage(request),
          browser.storage.local.get(RUNTIME_STATUS_STORAGE_KEY),
        ]);
        if (!active) return;
        const parsed = parsePublicSettingsActionResponse(settingsResponse, request.id);
        if (!parsed) throw new Error('Invalid public settings response.');
        setSettings(parsed.payload);
        setRuntimeStatus(
          parseRuntimeStatus(storedStatus[RUNTIME_STATUS_STORAGE_KEY]),
        );
        setError(null);
      } catch {
        if (active) setError('无法读取 SubTwin 设置，请重新打开弹窗。');
      }
    };
    // 弹窗打开期间字幕状态可能变化（例如识别完成、翻译出错），直接跟随更新。
    const onStorageChanged = (
      changes: Record<string, { readonly newValue?: unknown }>,
      area: string,
    ) => {
      const change = changes[RUNTIME_STATUS_STORAGE_KEY];
      if (!active || area !== 'local' || change === undefined) return;
      setRuntimeStatus(parseRuntimeStatus(change.newValue));
    };
    void refresh();
    browser.storage.onChanged.addListener(onStorageChanged);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  if (!settings) {
    return (
      <main className="popup" aria-busy="true">
        <PopupHeader />
        <div className="popup__skeleton" />
        <p className="popup__muted">正在读取字幕状态…</p>
        {error ? <p className="st-note" data-tone="error" role="alert">{error}</p> : null}
      </main>
    );
  }

  const display = createDisplayStatus(settings, runtimeStatus);
  const source = SOURCE_LABELS[settings.provider];
  const toggleEnabled = async (enabled: boolean) => {
    const previous = settings;
    setSettings({ ...previous, enabled });
    setSaving(true);
    try {
      const request = createEnabledSetRequest(enabled);
      const response = await browser.runtime.sendMessage(request);
      const parsed = parseEnabledSetActionResponse(response, request.id);
      if (parsed?.payload.status !== 'success') {
        throw new Error('Settings update was rejected.');
      }
      setSettings({
        enabled: parsed.payload.enabled,
        provider: parsed.payload.provider,
      });
      setError(null);
    } catch {
      setSettings(previous);
      setError('开关保存失败，字幕状态没有改变。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="popup">
      <PopupHeader>
        <label className="st-switch" title={settings.enabled ? '关闭双语字幕' : '开启双语字幕'}>
          <input
            aria-label="启用 SubTwin 双语字幕"
            checked={settings.enabled}
            disabled={saving}
            role="switch"
            type="checkbox"
            onChange={(event) => void toggleEnabled(event.currentTarget.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </PopupHeader>

      <section className="st-status" data-tone={display.tone} aria-live="polite">
        <span className="st-status__dot" aria-hidden="true" />
        <div>
          <strong>{display.title}</strong>
          <p>{display.body}</p>
        </div>
      </section>

      <section className="popup__source" aria-label="当前字幕来源">
        <span className="popup__label">字幕来源</span>
        <div>
          <strong>{source.name}</strong>
          <small>{source.detail}</small>
        </div>
      </section>

      {error ? <p className="st-note" data-tone="error" role="alert">{error}</p> : null}

      <button
        className="st-button st-button--primary popup__action"
        type="button"
        onClick={() => void browser.runtime.openOptionsPage()}
      >
        {settings.provider === 'unset' ? '选择字幕来源与样式' : '字幕与翻译设置'}
      </button>

      <ul className="popup__facts">
        <li>Netflix 官方中文优先（简体优先，没有时用繁体）。</li>
        <li>华语原声影片保留 Netflix 原字幕，不做处理。</li>
        <li>播放页右下角的「双」按钮可随时调整字幕。</li>
      </ul>
    </main>
  );
}

function PopupHeader(props: { readonly children?: ReactNode }) {
  return (
    <header className="popup__header">
      <div className="st-brand">
        <span className="st-mark" aria-hidden="true">双</span>
        <div>
          <h1>SubTwin</h1>
          <p>Netflix 中英双语字幕</p>
        </div>
      </div>
      {props.children}
    </header>
  );
}

function createDisplayStatus(
  settings: PopupSettings,
  runtime: RuntimeStatus | null,
): DisplayStatus {
  if (!settings.enabled) {
    return {
      title: '双语字幕已关闭',
      body: 'Netflix 原生字幕不会被 SubTwin 修改。',
      tone: 'idle',
    };
  }
  if (runtime) {
    return {
      title: TITLE_BY_MODE[runtime.mode],
      body: runtimeStatusMessage(runtime),
      tone: toneForMode(runtime.mode),
    };
  }
  if (settings.provider === 'unset') {
    return {
      title: '已就绪',
      body: '打开 Netflix 影片后，有官方中文字幕时会直接显示中英双语。',
      tone: 'active',
    };
  }
  return {
    title: settings.provider === 'deepseek' ? 'DeepSeek 已就绪' : 'Google 翻译已就绪',
    body: '打开 Netflix 影片后会先检查官方字幕，再按你的选择翻译。',
    tone: 'active',
  };
}

function toneForMode(mode: RuntimeMode): StatusTone {
  if (mode === 'error') return 'error';
  if (mode === 'discovering' || mode === 'unset') return 'pending';
  if (mode === 'chinese-original') return 'idle';
  return 'active';
}

function createPublicSettingsRequest() {
  return createMessage({
    id: `popup-${Date.now()}-${crypto.randomUUID()}`,
    source: 'popup',
    type: 'settings/public-get',
    payload: {},
  });
}

function createEnabledSetRequest(enabled: boolean) {
  return createMessage({
    id: `popup-${Date.now()}-${crypto.randomUUID()}`,
    source: 'popup',
    type: 'settings/enabled-set',
    payload: { enabled },
  });
}
