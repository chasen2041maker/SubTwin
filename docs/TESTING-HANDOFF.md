# SubTwin 实机测试交接（2026-11-05）

> 用法：用户先完成「0. 用户先做」，再把本文件**全文**粘贴给负责测试的 Claude（已连接 Claude in Chrome 的那个账号）。测试者只需要浏览器，不需要读写本地文件。

## 测试者须知

你要在用户的 Chrome 里实测 Netflix 字幕扩展 **SubTwin** 的新版本，并按第 7 节格式输出测试报告；用户会把报告贴回开发会话。

- **只测试、不修复**：不改代码，不改 Netflix 账号或个人资料设置，不改 DeepSeek Key，不点设置页里的“清理缓存”。
- **在新标签页里测试**，测试完关闭自己开的标签页。
- 每部影片开始前先记录 Netflix 当前选的字幕（第 2 节脚本 S1 的 `nflxSubtitle`），测完按第 6 节恢复。
- 遇到失败不要反复重试同一操作：最多重试 2 次，然后把证据（日志、S1 输出、截图）写进报告继续下一项。
- 如果影片没自动播放，点画面中央播放，或执行 `document.querySelector('video')?.play()`；片头可快进到有对白的位置（例如拖到 3–5 分钟）。

## 0. 用户先做（测试者无法操作 `chrome://` 页面）

1. 在 Chrome 打开 `chrome://extensions`，找到 SubTwin，点“重新加载”。扩展目录是 `C:\company\own\SubTwin\.output\chrome-mv3`（2026-11-05 20:52 构建，对应提交 `df50093`，已推送到 GitHub `main`）。**之前已加载过也要重新加载**，否则测的是旧版本。
2. 确认这个 Chrome 已登录 Netflix，且 Claude in Chrome 已连接到测试账号。
3. 用户的 SubTwin 日常设置：字幕来源 **DeepSeek**（模型 `deepseek-v4-flash`）。测试中会临时改成“原生双语”，最后必须改回 DeepSeek。

## 1. 怎么观察 SubTwin

**播放页控制台**：播放页右下角红色「双」按钮，点开是 SubTwin 控制台。顶部是总开关和状态（状态名 + 一行说明），“字幕来源”分段可切换 原生双语 / Google / DeepSeek，下面可能有一条提示；“诊断信息”分组展开后有“英文字幕 / 中文字幕 / 官方中文 / 字幕链路”。

**控制台日志**（用 `read_console_messages`，pattern 填 `\[SubTwin\]`）。为确保抓到页面一加载就产生的日志，**每次导航前先对该标签页调用一次 `read_console_messages`（clear: true）**。关键日志：

| 日志 | 含义 |
| --- | --- |
| `[SubTwin] Netflix controlled track capture: switch_started <语言>` | SubTwin 正在临时切换 Netflix 字幕轨以抓取该语言的字幕正文 |
| `... controlled track capture: body_captured <语言>` | 抓到了该语言正文 |
| `... controlled track capture: timed_out <语言>` | 等了 8 秒没抓到 |
| `... controlled track capture: restored <语言>` | 已把 Netflix 字幕轨切回原来那条 |
| `[SubTwin] Netflix timed-text ingest: route_changed <模式> <范围> <英文轨ID> <zh 或 no-zh>` | SubTwin 的处理模式。模式取值：`chinese-original`（华语原声，不处理）、`official`（原生双语）、`deepseek`、`google-free`、`discovering`（识别中）、`provider-unset`、`missing-English` 等 |
| `[SubTwin] Netflix timed-text ingest: timed_text_accepted dual` | 英文和中文正文都已解析 |
| `[SubTwin] Netflix timed-text download: started <语言>` | 后台下载某语言字幕正文 |

## 2. 检查脚本（用 `javascript_tool` 在 Netflix 页面执行）

**S1 状态快照**：

```js
(() => {
  const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
  const ids = api?.getAllPlayerSessionIds?.() ?? [];
  const id = ids.find((x) => String(x).startsWith('watch')) ?? ids[0];
  const p = id === undefined ? undefined : api.getVideoPlayerBySessionId(id);
  const t = p?.getTimedTextTrack?.();
  const a = (p?.getAudioTrackList?.() ?? []).find((x) => x.isNative);
  const host = document.getElementById('subtwin-subtitle-overlay');
  const lines = [...(host?.shadowRoot?.querySelectorAll('.subtwin-overlay__line') ?? [])]
    .map((n) => n.textContent.trim()).filter(Boolean);
  const native = document.querySelector('.player-timedtext');
  return {
    path: location.pathname,
    videoMs: Math.round((document.querySelector('video')?.currentTime ?? 0) * 1000),
    nflxSubtitle: t ? `${t.displayName} (${t.bcp47})` : null,
    originalAudio: a ? `${a.displayName} (${a.bcp47})` : null,
    subtwinLines: lines,
    nativeText: native?.innerText?.trim() ?? '',
    nativeHidden: native ? getComputedStyle(native).visibility === 'hidden' : null,
  };
})()
```

- `subtwinLines`：SubTwin 字幕层当前显示的行（空数组 = SubTwin 没有显示任何字幕）。
- `nativeHidden: true` 表示 Netflix 原字幕被 SubTwin 隐藏（只应在 SubTwin 正在显示双语时出现）。

**S2 变化采样器**（可选，用来证明字幕轨从未被切换、或中英是否同时出现）。安装：

```js
(() => {
  clearInterval(window.__stWatch);
  window.__stLog = [];
  let last = '';
  window.__stWatch = setInterval(() => {
    const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
    const ids = api?.getAllPlayerSessionIds?.() ?? [];
    const id = ids.find((x) => String(x).startsWith('watch')) ?? ids[0];
    const t = id === undefined ? undefined : api.getVideoPlayerBySessionId(id)?.getTimedTextTrack?.();
    const host = document.getElementById('subtwin-subtitle-overlay');
    const lines = [...(host?.shadowRoot?.querySelectorAll('.subtwin-overlay__line') ?? [])]
      .map((n) => n.textContent.trim()).filter(Boolean);
    const native = document.querySelector('.player-timedtext')?.innerText?.trim() ?? '';
    const key = JSON.stringify([t?.bcp47, lines, native]);
    if (key === last) return;
    last = key;
    window.__stLog.push({
      ms: Math.round(performance.now()),
      videoMs: Math.round((document.querySelector('video')?.currentTime ?? 0) * 1000),
      track: t?.bcp47 ?? null,
      lines,
      native,
    });
  }, 100);
  return 'S2 installed';
})()
```

读取：`window.__stLog.slice(-40)`；停止：`clearInterval(window.__stWatch)`。

## 3. T1 华语原声影片保持不处理 —— 《陈情令》

- 地址：`https://www.netflix.com/watch/81200231`
- SubTwin 来源：保持 **DeepSeek**（这就是用户平时的设置）。

步骤：

1. 清空日志后导航到上面的地址，等播放器出现并开始播放，立刻执行 S1（记录基线 `nflxSubtitle`，预计是繁体中文）并安装 S2。
2. 播放到有对白的位置，持续约 60 秒，期间执行 S1 三次。
3. 读取 `[SubTwin]` 日志与 `window.__stLog`。
4. 点开右下角「双」控制台，记录状态区文字、状态点颜色，以及“字幕来源”下有无提示条。

通过标准（全部满足）：

- 日志里**没有** `controlled track capture: switch_started`。
- 有 `route_changed chinese-original ...`（之前可能先出现 `discovering`）。
- S1 的 `originalAudio` 是中文（`zh…`），`subtwinLines` 始终为 `[]`，`nativeHidden` 为 `false`，`nativeText` 有中文字幕。
- `window.__stLog` 里 `track` 从头到尾不变（等于基线）。
- 控制台状态为「华语原声」，说明为「保留 Netflix 原字幕，SubTwin 不做任何处理。」，状态点为灰色，没有来源提示条。

## 4. T2 只有繁体中文官方字幕 —— Temptation Island

- 地址：`https://www.netflix.com/watch/81774488`
- SubTwin 来源：在「双」控制台里切到 **原生双语**（记得最后改回 DeepSeek）。

步骤：

1. 清空日志后导航，开始播放后执行 S1 记录基线 `nflxSubtitle`。
2. 切换来源为“原生双语”（若尚未切换），播放到有对白的位置约 60 秒，期间执行 S1 三次。
3. 读取日志；展开控制台“诊断信息”。

通过标准：

- 有 `route_changed official ... zh`。
- S1 的 `subtwinLines` 有两行：一行英文，一行**繁体中文**（例如含「這」「們」「說」「麼」等字），与对白同步出现。
- 控制台状态「官方双语」；“字幕来源”下的提示为「本片有 Netflix 官方繁体中文，双语字幕无需调用翻译。」；诊断信息“官方中文”为「Netflix 官方繁体中文」，“中文字幕”为 `zh-Hant · …`。
- 如果日志出现 `switch_started`，最后必须有 `restored`，且之后 S1 的 `nflxSubtitle` 回到基线。

## 5. T3 英语片回归 + T4 中途离开再打开 —— 《星期三》

- 地址：`https://www.netflix.com/watch/81257204`

**T3a 原生双语**（来源保持“原生双语”）：

1. 清空日志后导航，记录基线 `nflxSubtitle`（预计英文 CC）。播放到有对白处约 60 秒，执行 S1 三次。
2. 通过标准：`route_changed official ... zh`；`subtwinLines` 为英文 + **简体中文**两行；诊断信息“官方中文”为「Netflix 官方简体中文」；日志里**没有** `timed-text download: started zh-Hant`（有简体时不应下载繁体）。

**T3b DeepSeek**（在控制台把来源切回 **DeepSeek**）：

1. 继续播放约 60 秒，安装 S2，读 `window.__stLog`。
2. 通过标准：`route_changed deepseek ...`；`subtwinLines` 为英文 + 简体中文译文；S2 记录中英文行与中文行在同一条记录里同时出现（不应长期只有英文、隔 0.5 秒以上才补中文）；控制台状态「DeepSeek 翻译」。

**T4 中途离开再打开（本轮修复的重点）**。目标：在 SubTwin 正在切换字幕轨抓正文时离开播放页，再回到同一部影片，双语仍能出现。**离开和返回都必须是页面内跳转（不能整页刷新）**，否则测不到这个问题。

1. 清空日志，导航到 `https://www.netflix.com/watch/81257204`（整页加载）。页面加载后立刻执行 `window.__stMarker = Date.now()`。
2. 每隔约 1 秒读一次日志。看到 `controlled track capture: switch_started <语言>` 后，**在该语言的 `body_captured` 出现之前**，点击播放器左上角的返回箭头（“返回浏览”，可用 `find` 查找 back / 返回 按钮）。
   - 若来不及（`body_captured` 已出现），这一轮无效：重新整页导航回第 1 步再试，最多 3 次；3 次都来不及就在报告中注明“未能复现中途离开”。
3. 确认已在浏览页：`location.pathname` 是 `/browse` 之类，且 `window.__stMarker` 仍存在（证明没有整页刷新）。
4. 期望约 3 秒内出现日志 `controlled track capture: restored <语言>`。在浏览页停留 20 秒（顶部预告片自动播放也没关系），期间**不应再出现** `switch_started` 或 `timed_out`，也不应出现别的影片的 `route_changed`。
5. 执行 `history.back()` 回到播放页（同样确认 `window.__stMarker` 仍在），必要时点播放。
6. 期望 15 秒内依次出现：`switch_started zh-Hans` → `body_captured zh-Hans` → `restored`，以及 `timed_text_accepted dual`；S1 的 `subtwinLines` 为两行（英文 + 中文）。
7. 再做一次简单的离开-返回（点返回箭头，等 5 秒，`history.back()`）：期望几秒内恢复两行字幕，这次**不需要**再出现 `switch_started`。

T4 通过标准：第 4 步与第 6 步、第 7 步都满足。失败时把第 2–7 步的完整 `[SubTwin]` 日志贴进报告。

## 6. 收尾（必须做）

1. 在「双」控制台把 SubTwin 来源改回 **DeepSeek**。
2. 把每部影片的 Netflix 字幕恢复到测试前记录的基线（用 Netflix 播放器右下角的“音频和字幕”菜单选择，这样 Netflix 会记住）。按以往记录：《星期三》为英文 CC，《陈情令》为繁体中文；Temptation Island 按本次记录的基线。
3. 执行 `clearInterval(window.__stWatch)`，关闭测试打开的标签页。

## 7. 报告格式（直接在对话里输出）

```text
SubTwin 实机测试报告（日期、Chrome 版本如可得）

| 项目 | 结果 | 关键证据 |
| T1 华语原声不处理 | 通过/失败 | route_changed=…；switch_started=无/有；subtwinLines=…；控制台状态=… |
| T2 繁体中文后备 | … | … |
| T3a 星期三 原生双语 | … | … |
| T3b 星期三 DeepSeek | … | … |
| T4 中途离开再打开 | 通过/失败/未能复现 | 第4步日志…；第6步日志…；第7步… |
| 收尾恢复 | 已完成/未完成 | 来源=DeepSeek；各片字幕=… |

异常与观察：
- （任何不符合预期的现象、截图描述、时间点）

失败项的完整 [SubTwin] 日志：
（按项目分段粘贴）
```

## 8. 用户手动检查（可选，测试者无法打开扩展页面）

- **弹窗**：在《陈情令》播放时点浏览器工具栏的 SubTwin 图标，应显示「华语原声影片」（灰点）；在《星期三》播放时显示「官方双语」或「DeepSeek 翻译中」（绿点）；开关可关闭/开启，弹窗打开期间状态会随播放页变化。
- **设置页**（右键图标 →“选项”）：深色风格与控制台一致；“字幕来源”三张卡片；选 Google 时出现黄色隐私提示；改英文字体/字号后右侧预览立即变化；窄窗口下不出现横向滚动。
- **README 截图**：如需更新，截一张带中英双语字幕的播放画面（例如 Temptation Island 的英文 + 繁体中文），交给开发会话替换 `docs/screenshots/`。
