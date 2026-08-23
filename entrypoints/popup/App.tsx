import { useEffect, useState } from 'react';

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

interface DisplayStatus {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly tone: 'attention' | 'muted' | 'ready';
}

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
    void refresh();
    return () => {
      active = false;
    };
  }, []);

  if (!settings) {
    return (
      <main className="popup-shell" aria-busy="true">
        <div className="popup-skeleton" />
        <p className="popup-muted">正在读取字幕状态…</p>
        {error ? <p className="popup-error">{error}</p> : null}
      </main>
    );
  }

  const display = createDisplayStatus(settings, runtimeStatus);
  const toggleEnabled = async (enabled: boolean) => {
    const previous = settings;
    const next = { ...previous, enabled };
    setSettings(next);
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
    <main className="popup-shell">
      <header className="popup-header">
        <div>
          <p className="popup-kicker">NETFLIX BILINGUAL SUBTITLES</p>
          <h1>SubTwin</h1>
        </div>
        <label className="popup-switch">
          <span>{settings.enabled ? '已启用' : '已暂停'}</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={saving}
            onChange={(event) => void toggleEnabled(event.currentTarget.checked)}
          />
        </label>
      </header>

      <section className={`status-card status-card--${display.tone}`} aria-live="polite">
        <p className="status-eyebrow">{display.eyebrow}</p>
        <h2>{display.title}</h2>
        <p>{display.body}</p>
      </section>

      {error ? <p className="popup-error" role="alert">{error}</p> : null}

      <div className="popup-actions">
        <button
          className="primary-action"
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          {settings.provider === 'unset' ? '选择翻译方式' : '字幕与翻译设置'}
        </button>
        <p className="popup-footnote">
          官方中文字幕始终优先，存在时不会调用外部翻译。
        </p>
      </div>
    </main>
  );
}

function createDisplayStatus(
  settings: PopupSettings,
  runtime: RuntimeStatus | null,
): DisplayStatus {
  if (!settings.enabled) {
    return {
      eyebrow: 'PAUSED',
      title: '字幕增强已暂停',
      body: 'Netflix 原生字幕不会被 SubTwin 修改。',
      tone: 'muted',
    };
  }
  if (runtime) {
    const titleByMode: Record<RuntimeMode, string> = {
      deepseek: 'DeepSeek 上下文翻译',
      discovering: '正在识别当前影片',
      error: '字幕增强暂不可用',
      'google-free': 'Google 免费翻译',
      official: '使用 Netflix 官方双语',
      unset: '尚未选择翻译方式',
    };
    return {
      eyebrow: runtime.mode.toUpperCase(),
      title: titleByMode[runtime.mode],
      body: runtimeStatusMessage(runtime),
      tone: runtime.mode === 'error' || runtime.mode === 'unset'
        ? 'attention'
        : runtime.mode === 'discovering'
          ? 'muted'
          : 'ready',
    };
  }
  if (settings.provider === 'unset') {
    return {
      eyebrow: 'ACTION NEEDED',
      title: '先选择翻译方式',
      body: '在你明确选择前，SubTwin 不会把任何字幕发送给外部服务。',
      tone: 'attention',
    };
  }
  return {
    eyebrow: 'READY',
    title: settings.provider === 'deepseek' ? 'DeepSeek 已就绪' : 'Google 免费翻译已就绪',
    body: '打开 Netflix 后会先检查官方中文字幕，再决定是否翻译。',
    tone: 'ready',
  };
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
