import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  createMessage,
  type OptionsSettingsPatch,
} from '../../src/shared/messages';
import {
  parseCacheClearActionResponse,
  parseDeepSeekTestActionResponse,
  parseOptionsUpdateActionResponse,
  parsePrivateSettingsActionResponse,
} from '../../src/storage/action-client';
import {
  normalizeSettings,
  type SubtitleFontFamily,
  type SubTwinSettings,
  type TranslationProviderSetting,
} from '../../src/storage/schema';
import {
  SUBTITLE_FONT_OPTIONS,
  subtitleFontStack,
} from '../../src/renderer/subtitle-fonts';

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

  const persist = (
    next: SubTwinSettings,
    field: keyof OptionsSettingsPatch,
  ) => {
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
        selectOptionsSettingsPatch(normalized, field),
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
  const updateSettings = (
    field: keyof OptionsSettingsPatch,
    update: (current: SubTwinSettings) => SubTwinSettings,
  ) => {
    const current = settingsRef.current;
    if (current) persist(update(current), field);
  };

  if (!settings) {
    return (
      <main className="options" aria-busy="true">
        <OptionsHeader saveLabel="正在读取设置…" saveState="idle" />
        <div className="options__loading" />
        {loadError ? <p className="st-note" data-tone="error" role="alert">{loadError}</p> : null}
      </main>
    );
  }

  const updateAppearance = <Key extends keyof SubTwinSettings['appearance']>(
    key: Key,
    value: SubTwinSettings['appearance'][Key],
  ) => updateSettings('appearance', (current) => ({
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

  const setProvider = (provider: TranslationProviderSetting) =>
    updateSettings('provider', (current) => ({ ...current, provider }));

  return (
    <main className="options">
      <OptionsHeader saveLabel={saveLabel(saveState)} saveState={saveState} />

      <div className="options__layout">
        <div className="options__main">
          <section className="options-panel" aria-labelledby="source-title">
            <header className="options-panel__header">
              <div>
                <h2 id="source-title">字幕来源</h2>
                <p>
                  Netflix 官方中文始终优先（简体优先，没有时用繁体）；只有你明确选择翻译服务时，
                  SubTwin 才会发送英文字幕。华语原声影片保留 Netflix 原字幕，不做处理。
                </p>
              </div>
              <label className="st-switch" title="开启或关闭双语字幕">
                <input
                  aria-label="启用 SubTwin 双语字幕"
                  checked={settings.enabled}
                  role="switch"
                  type="checkbox"
                  onChange={(event) => updateSettings('enabled', (current) => ({
                    ...current,
                    enabled: event.currentTarget.checked,
                  }))}
                />
                <span aria-hidden="true" />
              </label>
            </header>

            <fieldset className="source-options">
              <legend className="visually-hidden">选择字幕来源</legend>
              <SourceOption
                checked={settings.provider === 'unset'}
                detail="只使用 Netflix 官方英文与中文字幕，不发送给任何外部服务。"
                badge="推荐"
                name="Netflix 原生双语"
                onSelect={() => setProvider('unset')}
                value="unset"
              />
              <SourceOption
                checked={settings.provider === 'google-free'}
                detail="逐句翻译、响应快；非官方接口，可能随时限流或失效。"
                badge="免 Key · 实验性"
                name="Google 翻译"
                onSelect={() => setProvider('google-free')}
                value="google-free"
              />
              <SourceOption
                checked={settings.provider === 'deepseek'}
                detail="批量参考前后文翻译，对白与专有名词更自然。"
                badge="自备 Key"
                name="DeepSeek"
                onSelect={() => setProvider('deepseek')}
                value="deepseek"
              />
            </fieldset>
            {settings.provider === 'google-free' ? (
              <p className="st-note" data-tone="warn">
                Google 翻译使用 GET 查询：单句英文字幕会出现在发送给 Google 的地址里，
                也可能留在网络设备或浏览器诊断记录中。
              </p>
            ) : null}
          </section>

          <section
            className="options-panel"
            aria-labelledby="deepseek-title"
            data-dimmed={settings.provider !== 'deepseek'}
          >
            <header className="options-panel__header">
              <div>
                <h2 id="deepseek-title">DeepSeek 连接</h2>
                <p>
                  {settings.provider === 'deepseek'
                    ? '当前正在使用 DeepSeek。Key 只保存在扩展本地存储，不进入页面消息或诊断信息。'
                    : '可以先填好 Key，之后在字幕来源里切换到 DeepSeek。'}
                </p>
              </div>
            </header>
            <div className="field-grid">
              <div className="field field--wide">
                <label htmlFor="deepseek-key">API Key</label>
                <div className="key-field">
                  <input
                    id="deepseek-key"
                    autoComplete="off"
                    placeholder="sk-…"
                    spellCheck={false}
                    type={showKey ? 'text' : 'password'}
                    value={settings.deepseek.apiKey}
                    onChange={(event) => updateSettings('deepseek', (current) => ({
                      ...current,
                      deepseek: {
                        ...current.deepseek,
                        apiKey: event.currentTarget.value,
                      },
                    }))}
                  />
                  <button
                    aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                    className="st-button"
                    type="button"
                    onClick={() => setShowKey((visible) => !visible)}
                  >
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>
              <label className="field" htmlFor="deepseek-model">
                <span>模型</span>
                <select
                  id="deepseek-model"
                  value={settings.deepseek.model}
                  onChange={(event) => updateSettings('deepseek', (current) => ({
                    ...current,
                    deepseek: {
                      ...current.deepseek,
                      model: event.currentTarget.value as SubTwinSettings['deepseek']['model'],
                    },
                  }))}
                >
                  <option value="deepseek-v4-flash">DeepSeek V4 Flash（快）</option>
                  <option value="deepseek-v4-pro">DeepSeek V4 Pro（更准）</option>
                </select>
              </label>
              <div className="field field--action">
                <button
                  className="st-button"
                  disabled={testState.kind === 'working'}
                  type="button"
                  onClick={() => void testDeepSeek()}
                >
                  {testState.kind === 'working' ? '正在测试…' : '保存后测试连接'}
                </button>
              </div>
            </div>
            {testState.message ? (
              <p className="st-note" data-tone={noteTone(testState.kind)} role="status">
                {testState.message}
              </p>
            ) : null}
          </section>

          <section className="options-panel" aria-labelledby="appearance-title">
            <header className="options-panel__header">
              <div>
                <h2 id="appearance-title">字幕样式</h2>
                <p>英文和中文分别设置；修改会自动保存，并在播放页下一句字幕时生效。</p>
              </div>
            </header>

            <div className="language-grid">
              <LanguageControls
                label="英文"
                line={settings.appearance.english}
                onChange={(patch) => updateLine('english', patch)}
              />
              <LanguageControls
                label="中文"
                line={settings.appearance.chinese}
                onChange={(patch) => updateLine('chinese', patch)}
              />
            </div>

            <div className="layout-grid">
              <Segmented
                label="上下顺序"
                options={[['english-first', '英文在上'], ['chinese-first', '中文在上']]}
                value={settings.appearance.order}
                onChange={(order) => updateAppearance('order', order)}
              />
              <Segmented
                label="文字阴影"
                options={[['none', '无'], ['soft', '柔和'], ['strong', '强']]}
                value={settings.appearance.shadow}
                onChange={(shadow) => updateAppearance('shadow', shadow)}
              />
              <RangeControl
                label="垂直位置"
                max={80}
                min={0}
                suffix="%"
                value={settings.appearance.verticalOffsetPercent}
                onChange={(value) => updateAppearance('verticalOffsetPercent', value)}
              />
              <RangeControl
                label="两行间距"
                max={48}
                min={0}
                suffix="px"
                value={settings.appearance.lineSpacingPx}
                onChange={(value) => updateAppearance('lineSpacingPx', value)}
              />
              <RangeControl
                label="单行长度"
                max={100}
                min={50}
                suffix="%"
                value={settings.appearance.maxLineWidthPercent}
                onChange={(value) => updateAppearance('maxLineWidthPercent', value)}
              />
              <RangeControl
                label="背景不透明度"
                max={100}
                min={0}
                step={5}
                suffix="%"
                value={Math.round(settings.appearance.backgroundOpacity * 100)}
                onChange={(value) => updateAppearance('backgroundOpacity', value / 100)}
              />
            </div>
          </section>

          <section className="options-panel" aria-labelledby="cache-title">
            <header className="options-panel__header">
              <div>
                <h2 id="cache-title">翻译缓存</h2>
                <p>译文按影片、字幕轨、翻译服务与模型分别缓存在本机，重看时不必重新翻译。</p>
              </div>
            </header>
            <div className="button-row">
              <button className="st-button" type="button" onClick={() => requestClear('episode')}>
                清理当前剧集
              </button>
              <button
                className="st-button st-button--danger"
                type="button"
                onClick={() => requestClear('all')}
              >
                清理全部缓存
              </button>
            </div>
            {cacheState.message ? (
              <p className="st-note" data-tone={noteTone(cacheState.kind)} role="status">
                {cacheState.message}
              </p>
            ) : null}
          </section>
        </div>

        <aside className="options__preview" aria-label="实时字幕预览">
          <div className="preview-card">
            <div className="preview-card__heading">
              <h2>实时预览</h2>
              <span>16:9</span>
            </div>
            <SubtitlePreview settings={settings} />
            <p className="preview-card__caption">
              在 Netflix 播放页点右下角的「双」按钮，也可以边看边调，还能直接拖动字幕位置。
            </p>
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
        <div className="button-row button-row--end">
          <button className="st-button" type="button" onClick={() => clearDialog.current?.close()}>
            取消
          </button>
          <button
            className="st-button st-button--danger"
            type="button"
            onClick={() => void clearCache()}
          >
            确认清理
          </button>
        </div>
      </dialog>
    </main>
  );
}

function OptionsHeader(props: {
  readonly saveLabel: string;
  readonly saveState: SaveState;
}) {
  return (
    <header className="options__header">
      <div className="st-brand">
        <span className="st-mark" aria-hidden="true">双</span>
        <div>
          <h1>SubTwin 设置</h1>
          <p>Netflix 中英双语字幕</p>
        </div>
      </div>
      <p className="save-pill" data-state={props.saveState} role="status">
        <span aria-hidden="true" />
        {props.saveLabel}
      </p>
    </header>
  );
}

function SourceOption(props: {
  readonly badge: string;
  readonly checked: boolean;
  readonly detail: string;
  readonly name: string;
  readonly onSelect: () => void;
  readonly value: TranslationProviderSetting;
}) {
  return (
    <label className="source-option" data-checked={props.checked}>
      <input
        checked={props.checked}
        name="provider"
        type="radio"
        value={props.value}
        onChange={props.onSelect}
      />
      <span className="source-option__body">
        <span className="source-option__title">
          <strong>{props.name}</strong>
          <em>{props.badge}</em>
        </span>
        <small>{props.detail}</small>
      </span>
    </label>
  );
}

function Segmented<Value extends string>(props: {
  readonly label: string;
  readonly onChange: (value: Value) => void;
  readonly options: readonly (readonly [Value, string])[];
  readonly value: Value;
}) {
  return (
    <fieldset className="segmented-field">
      <legend>{props.label}</legend>
      <div className="segmented" style={{ '--segments': props.options.length } as CSSProperties}>
        {props.options.map(([value, text]) => (
          <label key={value} data-checked={props.value === value}>
            <input
              checked={props.value === value}
              name={props.label}
              type="radio"
              value={value}
              onChange={() => props.onChange(value)}
            />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LanguageControls({
  label,
  line,
  onChange,
}: {
  readonly label: string;
  readonly line: SubTwinSettings['appearance']['english'];
  readonly onChange: (patch: Partial<SubTwinSettings['appearance']['english']>) => void;
}) {
  return (
    <fieldset className="language-card" data-hidden={!line.visible}>
      <legend className="visually-hidden">{label}字幕样式</legend>
      <div className="language-card__header">
        <h3>{label}</h3>
        <label className="st-switch" title={`显示${label}字幕`}>
          <input
            aria-label={`显示${label}字幕`}
            checked={line.visible}
            role="switch"
            type="checkbox"
            onChange={(event) => onChange({ visible: event.currentTarget.checked })}
          />
          <span aria-hidden="true" />
        </label>
      </div>
      <label className="field">
        <span>字体</span>
        <select
          aria-label={`${label}字体`}
          value={line.fontFamily}
          onChange={(event) => onChange({
            fontFamily: event.currentTarget.value as SubtitleFontFamily,
          })}
        >
          {SUBTITLE_FONT_OPTIONS.map(([value, text]) => (
            <option key={value} value={value}>{text}</option>
          ))}
        </select>
      </label>
      <RangeControl
        ariaLabel={`${label}字号`}
        label="字号"
        max={72}
        min={12}
        suffix="px"
        value={line.fontSizePx}
        onChange={(fontSizePx) => onChange({ fontSizePx })}
      />
      <RangeControl
        ariaLabel={`${label}粗细`}
        label="粗细"
        max={900}
        min={100}
        step={100}
        suffix=""
        value={line.fontWeight}
        onChange={(fontWeight) => onChange({ fontWeight })}
      />
      <label className="color-field">
        <span>颜色</span>
        <input
          aria-label={`${label}颜色`}
          type="color"
          value={line.color}
          onChange={(event) => onChange({ color: event.currentTarget.value.toUpperCase() })}
        />
        <code>{line.color.toUpperCase()}</code>
      </label>
    </fieldset>
  );
}

function RangeControl({
  ariaLabel,
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  readonly ariaLabel?: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly suffix: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="range-field">
      <span>{label}</span>
      <output>{value}{suffix}</output>
      <input
        aria-label={ariaLabel ?? label}
        max={max}
        min={min}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function SubtitlePreview({ settings }: { readonly settings: SubTwinSettings }) {
  const { appearance } = settings;
  const lines = [
    { key: 'english', text: 'Some stories deserve a second voice.', line: appearance.english },
    { key: 'chinese', text: '有些故事，值得拥有第二种声音。', line: appearance.chinese },
  ] as const;
  const ordered = appearance.order === 'english-first' ? lines : [lines[1], lines[0]];
  const shadow = appearance.shadow === 'none'
    ? 'none'
    : appearance.shadow === 'strong'
      ? '0 2px 5px rgb(0 0 0 / 1), 0 0 2px rgb(0 0 0 / 1)'
      : '0 1px 2px rgb(0 0 0 / 0.9)';
  const visible = ordered.filter(({ line }) => line.visible);
  return (
    <div className="preview-frame">
      <div className="preview-frame__scene" aria-hidden="true" />
      {visible.length === 0 ? (
        <p className="preview-frame__empty">英文和中文字幕都已隐藏</p>
      ) : (
        <div
          className="preview-frame__subtitles"
          style={{
            bottom: `${appearance.verticalOffsetPercent}%`,
            gap: `${Math.round(appearance.lineSpacingPx * PREVIEW_SCALE)}px`,
            maxWidth: `${appearance.maxLineWidthPercent}%`,
            textShadow: shadow,
          }}
        >
          {visible.map(({ key, text, line }) => (
            <span
              key={key}
              lang={key === 'english' ? 'en' : 'zh-Hans'}
              style={{
                background: `rgb(0 0 0 / ${appearance.backgroundOpacity})`,
                color: line.color,
                fontFamily: subtitleFontStack(line.fontFamily),
                fontSize: `${Math.max(10, Math.round(line.fontSizePx * PREVIEW_SCALE))}px`,
                fontWeight: line.fontWeight,
              }}
            >
              {text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** 预览画面约为 1280px 宽播放器的一半大小，字号与间距按同一比例缩放。 */
const PREVIEW_SCALE = 0.5;

function saveLabel(state: SaveState): string {
  if (state === 'saving') return '正在保存…';
  if (state === 'saved') return '已保存到本机';
  if (state === 'error') return '保存失败，请重试';
  return '设置仅保存在本机';
}

function noteTone(kind: ActionState['kind']): string {
  if (kind === 'success') return 'success';
  if (kind === 'error') return 'error';
  return 'info';
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

function selectOptionsSettingsPatch(
  settings: SubTwinSettings,
  field: keyof OptionsSettingsPatch,
): OptionsSettingsPatch {
  if (field === 'enabled') return { enabled: settings.enabled };
  if (field === 'provider') return { provider: settings.provider };
  if (field === 'deepseek') return { deepseek: { ...settings.deepseek } };
  return { appearance: normalizeSettings(settings).appearance };
}

function createOptionsUpdateMessage(patch: OptionsSettingsPatch) {
  return createMessage({
    id: `options-${Date.now()}-${crypto.randomUUID()}`,
    source: 'options',
    type: 'settings/options-update',
    payload: { patch },
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
  patch: OptionsSettingsPatch,
): Promise<SubTwinSettings> {
  const normalized = normalizeSettings(settings);
  const request = createOptionsUpdateMessage(patch);
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
