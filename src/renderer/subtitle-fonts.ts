import type { SubtitleFontFamily } from '../storage/schema';

/** 字幕字体选项：页面控制台、设置页与预览共用同一份列表和字体栈。 */
export const SUBTITLE_FONT_OPTIONS: readonly (readonly [SubtitleFontFamily, string])[] = [
  ['sans', '清晰无衬线'],
  ['rounded', '圆体'],
  ['system', '系统字体'],
  ['serif', '衬线体'],
  ['mono', '等宽体'],
];

export function subtitleFontStack(value: SubtitleFontFamily): string {
  switch (value) {
    case 'mono':
      return 'ui-monospace, "Cascadia Mono", monospace';
    case 'rounded':
      return 'ui-rounded, "Arial Rounded MT Bold", "Microsoft YaHei", sans-serif';
    case 'serif':
      return 'Georgia, "Noto Serif CJK SC", "Songti SC", serif';
    case 'system':
      return 'system-ui, -apple-system, "Segoe UI", sans-serif';
    case 'sans':
      return '"Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif';
  }
}
