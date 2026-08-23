import { useEffect, useRef, useState } from 'react';

import { createMessage } from '../../src/shared/messages';
import {
  parseCacheClearActionResponse,
  parseDeepSeekTestActionResponse,
  parseOptionsUpdateActionResponse,
  parsePrivateSettingsActionResponse,
} from '../../src/storage/action-client';
import {
  normalizeSettings,
  type SubTwinSettings,
} from '../../src/storage/schema';

type SaveState = 'error' | 'idle' | 'saved' | 'saving';
type CacheScope = 'all' | 'episode';

interface ActionState {
  readonly kind: 'error' | 'idle' | 'success' | 'working';
  readonly message: string;
}

const INITIAL_ACTION: ActionState = { kind: 'idle', message: '' };

export default function App() {
  const [settings, setSettings] = useState<SubTwinSettings | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<ActionState>(INITIAL_ACTION);
  const [cacheState, setCacheState] = useState<ActionState>(INITIAL_ACTION);
  const [pendingClear, setPendingClear] = useState<CacheScope>('episode');
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveRevision = useRef(0);
  const lastSavedRevision = useRef(0);
  const credentialRevision = useRef(0);
  const confirmedEnabled = useRef<boolean | null>(null);
  const settingsRef = useRef<SubTwinSettings | null>(null);
  const clearDialog = useRef<HTMLDialogElement>(null);
  const pendingClearRef = useRef<CacheScope>('episode');

  useEffect(() => {
    let active = true;
    const request = createPrivateSettingsRequest();
    void browser.runtime.sendMessage(request).then(
      (response) => {
        if (!active) return;
        const parsed = parsePrivateSettingsActionResponse(response, request.id);
        if (!parsed) {
          setLoadError('无法读取本地设置。请重新打开设置页后重试。');
          return;
        }
        const loaded = parsed.payload.settings;
        confirmedEnabled.current = loaded.enabled;
        settingsRef.current = loaded;
        setSettings(loaded);
        setLoadError(null);
      },
      () => {
        if (active) setLoadError('无法读取本地设置。请检查扩展存储权限后重试。');
      },
    );
    return () => { active = false; };
  }, []);

  const persist = (next: SubTwinSettings) => {
    const previous = settingsRef.current;
    const normalized = normalizeSettings(next);
    const credentialsChanged = previous !== null && (
      previous.deepseek.apiKey !== normalized.deepseek.apiKey ||
      previous.deepseek.model !== normalized.deepseek.model
    );
    if (credentialsChanged) {
      credentialRevision.current += 1;
      setTestState(INITIAL_ACTION);
    }
    const revision = saveRevision.current + 1;
    saveRevision.current = revision;
    settingsRef.current = normalized;
    setSettings(normalized);
    setSaveState('saving');
    saveQueue.current = saveQueue.current
      .catch(() => false)
      .then(() => saveOptionsSettings(
        normalized,
        confirmedEnabled.current !== normalized.enabled,
      ))
      .then(
        (saved) => {
          lastSavedRevision.current = Math.max(lastSavedRevision.current, revision);
          confirmedEnabled.current = saved.enabled;
          if (saveRevision.current === revision) {
            settingsRef.current = saved;
            setSettings(saved);
            setSaveState('saved');
          }
          return true;
        },
        () => {
          if (saveRevision.current === revision) setSaveState('error');
          return false;
        },
      );
  };
  const updateSettings = (update: (current: SubTwinSettings) => SubTwinSettings) => {
    const current = settingsRef.current;
    if (current) persist(update(current));
  };

  if (!settings) {
    return (
      <main className="options-shell" aria-busy="true">
        <p className="page-kicker">SUBTITLE WORKROOM</p>
        <h1>正在准备设置台…</h1>
        <div className="loading-frame" />
        {loadError ? <p className="inline-error" role="alert">{loadError}</p> : null}
      </main>
    );
  }

  const updateAppearance = <Key extends keyof SubTwinSettings['appearance']>(
    key: Key,
    value: SubTwinSettings['appearance'][Key],
  ) => updateSettings((current) => ({
    ...current,
    appearance: { ...current.appearance, [key]: value },
  }));
  const updateLine = (
    language: 'chinese' | 'english',
    patch: Partial<SubTwinSettings['appearance']['english']>,
  ) => {
    const current = settingsRef.current;
    if (!current) return;
    updateAppearance(language, {
      ...current.appearance[language],
      ...patch,
    });
  };

  const testDeepSeek = async () => {
    const current = settingsRef.current;
    if (!current?.deepseek.apiKey.trim()) {
      setTestState({ kind: 'error', message: '请先填写并保存 DeepSeek API Key。' });
      return;
    }
    const testedCredentialRevision = credentialRevision.current;
    const requiredSaveRevision = saveRevision.current;
    setTestState({ kind: 'working', message: '正在由后台验证已保存的 Key…' });
    try {
      const saved = await saveQueue.current;
      if (
        credentialRevision.current !== testedCredentialRevision ||
        !saved ||
        lastSavedRevision.current < requiredSaveRevision
      ) {
        if (credentialRevision.current === testedCredentialRevision) {
          setTestState({
            kind: 'error',
            message: '最新的 Key 或模型尚未保存成功，请先解决保存错误。',
          });
        }
        return;
      }
      const request = createDeepSeekTestMessage();
      const response = await browser.runtime.sendMessage(request);
      if (credentialRevision.current !== testedCredentialRevision) return;
      setTestState(parseDeepSeekTestResponse(response, request.id));
    } catch {
      setTestState({ kind: 'error', message: '测试未完成，请稍后重试。' });
    }
  };

  const requestClear = (scope: CacheScope) => {
    pendingClearRef.current = scope;
    setPendingClear(scope);
    clearDialog.current?.showModal();
  };
  const clearCache = async () => {
    const scope = pendingClearRef.current;
    clearDialog.current?.close();
    setCacheState({ kind: 'working', message: '正在清理本地字幕缓存…' });
    try {
      const request = createCacheClearMessage(scope);
      const response = await browser.runtime.sendMessage(request);
      setCacheState(parseCacheClearResponse(response, scope, request.id));
    } catch {
      setCacheState({ kind: 'error', message: '缓存清理失败，请重新打开设置页后重试。' });
    }
  };

  return (
    <main className="options-shell">
      <header className="page-header">
        <div>
          <p className="page-kicker">SUBTITLE WORKROOM</p>
          <h1>把双语字幕调成你的样子</h1>
          <p className="page-intro">
            Netflix 官方简体中文字幕始终优先；只有官方缺失且你明确选择服务时，
            SubTwin 才会发送英文字幕进行翻译。
          </p>
        </div>
        <div className={`save-state save-state--${saveState}`} role="status">
          {saveState === 'saving' ? '正在保存' : null}
          {saveState === 'saved' ? '已保存到本机' : null}
          {saveState === 'error' ? '保存失败，请重试' : null}
          {saveState === 'idle' ? '设置仅保存在本机' : null}
        </div>
      </header>

      <div className="workspace-grid">
        <div className="settings-column">
          <section className="settings-section" aria-labelledby="general-title">
            <div className="section-heading">
              <span>01</span>
              <div>
                <h2 id="general-title">启用与翻译方式</h2>
                <p>新安装默认不选择外部服务。</p>
              </div>
            </div>

            <label className="toggle-row">
              <span>
                <strong>启用 SubTwin</strong>
                <small>关闭后保留 Netflix 原生字幕。</small>
              </span>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => updateSettings((current) => ({
                  ...current,
                  enabled: event.currentTarget.checked,
                }))}
              />
            </label>

            <fieldset className="provider-fieldset">
              <legend>选择外部翻译方式</legend>
              <label className={`provider-card ${settings.provider === 'unset' ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value="unset"
                  checked={settings.provider === 'unset'}
                  onChange={() => updateSettings((current) => ({
                    ...current,
                    provider: 'unset',
                  }))}
                />
                <span>
                  <strong>暂不使用外部翻译</strong>
                  <small>字幕不会发送给 DeepSeek 或 Google。</small>
                </span>
              </label>
              <label className={`provider-card ${settings.provider === 'google-free' ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value="google-free"
                  checked={settings.provider === 'google-free'}
                  onChange={() => updateSettings((current) => ({
                    ...current,
                    provider: 'google-free',
                  }))}
                />
                <span>
                  <strong>Google 免费翻译 <em>实验性 · 免 Key</em></strong>
                  <small>逐句响应快，但属于非保证接口，可能随时限流或失效。</small>
                </span>
              </label>
              <div className="privacy-note">
                Google Free 使用 GET 查询。单句英文字幕会出现在发送给 Google 的 URL 中，
                也可能出现在网络设备或浏览器诊断记录里。
              </div>
              <label className={`provider-card ${settings.provider === 'deepseek' ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value="deepseek"
                  checked={settings.provider === 'deepseek'}
                  onChange={() => updateSettings((current) => ({
                    ...current,
                    provider: 'deepseek',
                  }))}
                />
                <span>
                  <strong>DeepSeek <em>上下文感知 · 自备 Key</em></strong>
                  <small>批量参考前后文，适合对白与专有名词。</small>
                </span>
              </label>
            </fieldset>

            <div className="deepseek-panel">
              <label className="field-label" htmlFor="deepseek-key">DeepSeek API Key</label>
              <div className="key-field">
                <input
                  id="deepseek-key"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={settings.deepseek.apiKey}
                  onChange={(event) => updateSettings((current) => ({
                    ...current,
                    deepseek: {
                      ...current.deepseek,
                      apiKey: event.currentTarget.value,
                    },
                  }))}
                />
                <button type="button" onClick={() => setShowKey((visible) => !visible)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
              <p className="field-help">Key 只保存在浏览器扩展本地存储，不进入页面消息或诊断信息。</p>

              <label className="field-label" htmlFor="deepseek-model">模型</label>
              <select
                id="deepseek-model"
                value={settings.deepseek.model}
                onChange={(event) => updateSettings((current) => ({
                  ...current,
                  deepseek: {
                    ...current.deepseek,
                    model: event.currentTarget.value as SubTwinSettings['deepseek']['model'],
                  },
                }))}
              >
                <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
              </select>
              <button
                className="secondary-action"
                type="button"
                disabled={testState.kind === 'working'}
                onClick={() => void testDeepSeek()}
              >
                保存后测试连接
              </button>
              {testState.message ? (
                <p className={`action-message action-message--${testState.kind}`} role="status">
                  {testState.message}
                </p>
              ) : null}
            </div>
          </section>

          <section className="settings-section" aria-labelledby="appearance-title">
            <div className="section-heading">
              <span>02</span>
              <div>
                <h2 id="appearance-title">字幕排版</h2>
                <p>英语和中文可以分别显示和调整。</p>
              </div>
            </div>

            <LanguageControls
              label="English"
              language="english"
              line={settings.appearance.english}
              onChange={(patch) => updateLine('english', patch)}
            />
            <LanguageControls
              label="简体中文"
              language="chinese"
              line={settings.appearance.chinese}
              onChange={(patch) => updateLine('chinese', patch)}
            />

            <div className="control-grid">
              <label>
                <span>上下顺序</span>
                <select
                  value={settings.appearance.order}
                  onChange={(event) => updateAppearance(
                    'order',
                    event.currentTarget.value as SubTwinSettings['appearance']['order'],
                  )}
                >
                  <option value="english-first">英语在上</option>
                  <option value="chinese-first">中文在上</option>
                </select>
              </label>
              <label>
                <span>文字阴影</span>
                <select
                  value={settings.appearance.shadow}
                  onChange={(event) => updateAppearance(
                    'shadow',
                    event.currentTarget.value as SubTwinSettings['appearance']['shadow'],
                  )}
                >
                  <option value="none">关闭</option>
                  <option value="soft">柔和</option>
                  <option value="strong">清晰</option>
                </select>
              </label>
            </div>

            <RangeControl
              label="两行间距"
              value={settings.appearance.lineSpacingPx}
              min={0}
              max={28}
              suffix="px"
              onChange={(value) => updateAppearance('lineSpacingPx', value)}
            />
            <RangeControl
              label="距画面底部"
              value={settings.appearance.verticalOffsetPercent}
              min={4}
              max={32}
              suffix="%"
              onChange={(value) => updateAppearance('verticalOffsetPercent', value)}
            />
            <RangeControl
              label="字幕背景透明度"
              value={Math.round(settings.appearance.backgroundOpacity * 100)}
              min={0}
              max={90}
              suffix="%"
              onChange={(value) => updateAppearance('backgroundOpacity', value / 100)}
            />
          </section>

          <section className="settings-section" aria-labelledby="cache-title">
            <div className="section-heading">
              <span>03</span>
              <div>
                <h2 id="cache-title">本地翻译缓存</h2>
                <p>缓存按影片、字幕轨、翻译服务与模型隔离。</p>
              </div>
            </div>
            <div className="cache-actions">
              <button type="button" onClick={() => requestClear('episode')}>清理当前剧集</button>
              <button className="danger-action" type="button" onClick={() => requestClear('all')}>
                清理全部缓存
              </button>
            </div>
            {cacheState.message ? (
              <p className={`action-message action-message--${cacheState.kind}`} role="status">
                {cacheState.message}
              </p>
            ) : null}
          </section>
        </div>

        <aside className="preview-column" aria-label="实时字幕预览">
          <div className="preview-sticky">
            <div className="preview-heading">
              <p>LIVE TYPE PREVIEW</p>
              <span>16:9</span>
            </div>
            <SubtitlePreview settings={settings} />
            <p className="preview-caption">调整会立即保存，并在 Netflix 字幕层下一次渲染时生效。</p>
          </div>
        </aside>
      </div>

      <dialog ref={clearDialog} className="confirm-dialog" aria-labelledby="confirm-title">
        <h2 id="confirm-title">确认清理缓存？</h2>
        <p>
          {pendingClear === 'all'
            ? '所有已翻译字幕都会从本机删除，之后观看时需要重新翻译。'
            : '当前正在播放剧集的翻译会从本机删除。'}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={() => clearDialog.current?.close()}>取消</button>
          <button className="danger-action" type="button" onClick={() => void clearCache()}>
            确认清理
          </button>
        </div>
      </dialog>
    </main>
  );
}

function LanguageControls({
  label,
  language,
  line,
  onChange,
}: {
  readonly label: string;
  readonly language: 'chinese' | 'english';
  readonly line: SubTwinSettings['appearance']['english'];
  readonly onChange: (patch: Partial<SubTwinSettings['appearance']['english']>) => void;
}) {
  return (
    <fieldset className="language-controls">
      <legend>{label}</legend>
      <label className="compact-toggle">
        <input
          type="checkbox"
          checked={line.visible}
          onChange={(event) => onChange({ visible: event.currentTarget.checked })}
        />
        显示{language === 'english' ? '英语' : '中文'}
      </label>
      <label>
        <span>颜色</span>
        <input
          type="color"
          value={line.color}
          onChange={(event) => onChange({ color: event.currentTarget.value })}
        />
      </label>
      <label>
        <span>字号</span>
        <select
          value={line.fontSizePx}
          onChange={(event) => onChange({ fontSizePx: Number(event.currentTarget.value) })}
        >
          {[22, 26, 30, 34, 38, 42, 48, 54, 60].map((size) => (
            <option key={size} value={size}>{size}px</option>
          ))}
        </select>
      </label>
      <label>
        <span>字重</span>
        <select
          value={line.fontWeight}
          onChange={(event) => onChange({ fontWeight: Number(event.currentTarget.value) })}
        >
          <option value={400}>常规</option>
          <option value={500}>中等</option>
          <option value={600}>半粗</option>
          <option value={700}>粗体</option>
        </select>
      </label>
    </fieldset>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly suffix: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output>{value}{suffix}</output>
    </label>
  );
}

function SubtitlePreview({ settings }: { readonly settings: SubTwinSettings }) {
  const { appearance } = settings;
  const ordered = appearance.order === 'english-first'
    ? [
        { key: 'english', text: 'Some stories deserve a second voice.', line: appearance.english },
        { key: 'chinese', text: '有些故事，值得拥有第二种声音。', line: appearance.chinese },
      ]
    : [
        { key: 'chinese', text: '有些故事，值得拥有第二种声音。', line: appearance.chinese },
        { key: 'english', text: 'Some stories deserve a second voice.', line: appearance.english },
      ];
  const shadow = appearance.shadow === 'none'
    ? 'none'
    : appearance.shadow === 'strong'
      ? '0 2px 2px #000, 0 0 4px #000'
      : '0 1px 3px rgb(0 0 0 / 85%)';
  return (
    <div className="preview-frame">
      <div className="preview-film-mark">SUBTWIN · PREVIEW</div>
      <div
        className="preview-subtitles"
        style={{
          bottom: `${appearance.verticalOffsetPercent}%`,
          gap: `${appearance.lineSpacingPx}px`,
          background: `rgb(0 0 0 / ${appearance.backgroundOpacity})`,
          textShadow: shadow,
        }}
      >
        {ordered.map(({ key, text, line }) => line.visible ? (
          <div
            key={key}
            lang={key === 'english' ? 'en' : 'zh-Hans'}
            style={{
              color: line.color,
              fontSize: `${Math.max(14, Math.round(line.fontSizePx * 0.48))}px`,
              fontWeight: line.fontWeight,
            }}
          >
            {text}
          </div>
        ) : null)}
      </div>
    </div>
  );
}

function createDeepSeekTestMessage() {
  return createMessage({
    id: `options-${Date.now()}-${crypto.randomUUID()}`,
    source: 'options',
    type: 'settings/deepseek-test',
    payload: {},
  });
}

function createCacheClearMessage(scope: CacheScope) {
  return createMessage({
    id: `options-${Date.now()}-${crypto.randomUUID()}`,
    source: 'options',
    type: 'settings/cache-clear',
    payload: { scope },
  });
}

function createOptionsUpdateMessage(
  settings: SubTwinSettings,
  updateEnabled: boolean,
) {
  return createMessage({
    id: `options-${Date.now()}-${crypto.randomUUID()}`,
    source: 'options',
    type: 'settings/options-update',
    payload: { settings: normalizeSettings(settings), updateEnabled },
  });
}

function createPrivateSettingsRequest() {
  return createMessage({
    id: `options-${Date.now()}-${crypto.randomUUID()}`,
    source: 'options',
    type: 'settings/private-get',
    payload: {},
  });
}

async function saveOptionsSettings(
  settings: SubTwinSettings,
  updateEnabled: boolean,
): Promise<SubTwinSettings> {
  const normalized = normalizeSettings(settings);
  const request = createOptionsUpdateMessage(normalized, updateEnabled);
  const response = await browser.runtime.sendMessage(request);
  const parsed = parseOptionsUpdateActionResponse(response, request.id);
  if (parsed?.payload.status !== 'success') {
    throw new Error('Settings update was rejected.');
  }
  return { ...normalized, enabled: parsed.payload.enabled };
}

function parseDeepSeekTestResponse(value: unknown, requestId: string): ActionState {
  const payload = parseDeepSeekTestActionResponse(value, requestId)?.payload;
  if (payload?.status === 'success') {
    return { kind: 'success', message: '连接成功，已保存的 DeepSeek Key 可以使用。' };
  }
  const errorCode = typeof payload?.errorCode === 'string' ? payload.errorCode : '';
  const messageByCode: Record<string, string> = {
    authentication_failed: '认证失败，请检查 API Key。',
    insufficient_balance: 'DeepSeek 账户余额不足。',
    invalid_configuration: 'Key 或模型配置无效。',
    provider_unavailable: 'DeepSeek 暂时不可用，请稍后重试。',
    rate_limited: '请求过快，请稍后重试。',
    timeout: '连接超时，请检查网络后重试。',
  };
  return { kind: 'error', message: messageByCode[errorCode] ?? '连接测试失败，请稍后重试。' };
}

function parseCacheClearResponse(
  value: unknown,
  scope: CacheScope,
  requestId: string,
): ActionState {
  const payload = parseCacheClearActionResponse(value, requestId)?.payload;
  if (payload?.status === 'success') {
    return {
      kind: 'success',
      message: scope === 'all' ? '全部翻译缓存已清理。' : '当前剧集缓存已清理。',
    };
  }
  return { kind: 'error', message: '缓存清理失败，请稍后重试。' };
}
