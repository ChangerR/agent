/** 统一语义色：参考 pi 的 dark/light 主题角色，颜色针对 AgentLab 简化。
 * 布局来源与 MIT 署名见 docs/TUI-DESIGN.md、THIRD_PARTY_NOTICES.md。
 */
import chalk from 'chalk';
import { stripTerminalSequences, truncateToWidth, visibleWidth, type MarkdownTheme, type SelectListTheme } from '@earendil-works/pi-tui';

const light = process.env.AGENTLAB_THEME === 'light';
const fg = (dark: string, day: string) => (s: string) => chalk.hex(light ? day : dark)(s);
// 256 色终端直接使用深灰阶，避免 RGB 量化把深色面板变成亮灰块。
const bg = (dark: string, day: string) => (s: string) => chalk.level === 2 ? chalk.bgAnsi256(light ? 254 : 235)(s) : chalk.bgHex(light ? day : dark)(s);
export const ui = {
  accent: fg('#b49bdd', '#7653a6'), border: fg('#7c8cbd', '#8c92aa'),
  text: fg('#dedee3', '#252730'), muted: fg('#a3a6b3', '#646876'), dim: fg('#7c808e', '#777b87'),
  success: fg('#8cceae', '#24754d'), error: fg('#e59691', '#ad3833'), warning: fg('#dac57a', '#896916'),
  selectedBg: bg('#273447', '#e2e9f5'), userBg: bg('#273447', '#e9eef7'),
  toolPendingBg: bg('#292b32', '#eeeeef'), toolSuccessBg: bg('#22382e', '#eaf3ed'), toolErrorBg: bg('#402b2a', '#f8e9e8'),
};
export function safeTerminalText(s: string): string {
  return stripTerminalSequences(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function paddedBackground(lines: string[], width: number, background: (s: string) => string): string[] {
  return lines.map(line => {
    const value = truncateToWidth(line, Math.max(0, width));
    return background(value + ' '.repeat(Math.max(0, width - visibleWidth(value))));
  });
}
export const markdownTheme: MarkdownTheme = {
  heading: s => ui.warning(chalk.bold(s)), link: ui.accent, linkUrl: ui.dim,
  code: ui.accent, codeBlock: ui.success, codeBlockBorder: ui.muted,
  quote: s => ui.muted(chalk.italic(s)), quoteBorder: ui.dim, hr: ui.dim,
  listBullet: ui.accent, bold: s => chalk.bold(s), italic: s => chalk.italic(s),
  strikethrough: s => chalk.strikethrough(s), underline: s => chalk.underline(s),
};
export const selectTheme: SelectListTheme = {
  selectedPrefix: ui.accent, selectedText: s => ui.accent(chalk.bold(s)),
  description: ui.muted, scrollInfo: ui.dim, noMatch: ui.warning,
};
export const thinkingBorder = (thinking: string) => thinking === 'off' ? ui.dim : thinking === 'high' ? ui.accent : ui.border;
