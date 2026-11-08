// 设计稿的纯函数：HTML + 设计令牌 + 旋钮 → 可渲染文档。前端预览、导出和服务端交接共用一份
export interface DesignToken { name: string; value: string; description?: string | undefined }

export type DesignTweakType = 'color' | 'range' | 'select';

export interface DesignTweak {
  id: string;
  label: string;
  cssVar: string;
  type: DesignTweakType;
  value: string;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  unit?: string | undefined;
  options?: string[] | undefined;
}

export type TokenGroup = 'color' | 'font' | 'size' | 'shadow' | 'other';

export const DESIGN_SCRIPT_HOSTS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://cdn.tailwindcss.com'] as const;

// 设计稿是模型写的代码：断网（connect-src none）、不能提交表单，外部资源只放行字体、图片和常见 CDN
export const DESIGN_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${DESIGN_SCRIPT_HOSTS.join(' ')}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${DESIGN_SCRIPT_HOSTS.join(' ')}`,
  'font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net',
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  "form-action 'none'",
].join('; ');

const VAR_NAME = /^--[\w-]+$/;
const safeValue = (v: string) => !/[;{}<>]/.test(v);

const declarations = (items: { name: string; value: string }[]) =>
  items.filter((t) => VAR_NAME.test(t.name) && safeValue(t.value)).map((t) => `${t.name}:${t.value}`).join(';');

export const tweakCssValue = (t: Pick<DesignTweak, 'value' | 'unit' | 'type'>) => (t.type === 'range' ? `${t.value}${t.unit ?? ''}` : t.value);

// 令牌用 :root，稿子里可以覆盖；旋钮用 :root:root，无论稿子怎么写都以旋钮为准
export function designStyles(tokens: DesignToken[], tweaks: DesignTweak[]): string {
  const base = declarations(tokens);
  const knobs = declarations(tweaks.map((t) => ({ name: t.cssVar, value: tweakCssValue(t) })));
  return [base ? `:root{${base}}` : '', knobs ? `:root:root{${knobs}}` : ''].join('');
}

export function injectHead(html: string, head: string): string {
  const open = /<head\b[^>]*>/i.exec(html);
  if (open) return html.slice(0, open.index + open[0].length) + head + html.slice(open.index + open[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${head}</head>${html.slice(root.index + root[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}<head>${head}</head>${html.slice(doctype[0].length)}`;
  return `<head>${head}</head>${html}`;
}

export function composeDesignDoc(html: string, opts: { tokens: DesignToken[]; tweaks: DesignTweak[]; head?: string | undefined }): string {
  const style = `<style data-aw-design>${designStyles(opts.tokens, opts.tweaks)}</style>`;
  return injectHead(html, `${opts.head ?? ''}${style}`);
}

// 取 CSS 里的自定义属性；同名取第一次出现（亮色主题通常写在最前）
export function parseCssTokens(css: string): DesignToken[] {
  const out = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?:;|(?=\}))/g)) {
    const [, name, value] = m;
    if (name && value && !out.has(name) && !/^var\(/.test(value)) out.set(name, value);
  }
  return [...out].map(([name, value]) => ({ name, value }));
}

const COLOR_VALUE = /^(#[0-9a-f]{3,8}$|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\()/i;

export const isColorValue = (v: string) => COLOR_VALUE.test(v.trim());

export function tokenGroup(t: Pick<DesignToken, 'name' | 'value'>): TokenGroup {
  if (isColorValue(t.value)) return 'color';
  if (/font|family/i.test(t.name)) return 'font';
  if (/shadow/i.test(t.name)) return 'shadow';
  if (/^-?[\d.]+(px|rem|em|%|vh|vw)?$/.test(t.value.trim())) return 'size';
  return 'other';
}

export type TextEditResult = { ok: true; html: string; replaced: number } | { ok: false; error: string };

// 增量修改：每段原文必须唯一命中，否则宁可失败让模型重读，也不改错地方
export function applyTextEdits(html: string, edits: { oldText: string; newText: string }[]): TextEditResult {
  let next = html;
  for (const e of edits) {
    if (!e.oldText) return { ok: false, error: 'oldText 不能为空' };
    const first = next.indexOf(e.oldText);
    if (first < 0) return { ok: false, error: `找不到要替换的原文：${e.oldText.slice(0, 80)}` };
    if (next.indexOf(e.oldText, first + 1) >= 0) return { ok: false, error: `原文不唯一，请带上更多上下文：${e.oldText.slice(0, 80)}` };
    next = next.slice(0, first) + e.newText + next.slice(first + e.oldText.length);
  }
  return { ok: true, html: next, replaced: edits.length };
}

const HARD_COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(/gi;

function cssSources(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '');
  const inline = [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1] ?? '');
  return [...blocks, ...inline].join('\n');
}

// 写稿时的自检结果原样回给模型，让它自己修
export function lintDesign(html: string, ctx: { tokens: DesignToken[]; tweaks: DesignTweak[] }): string[] {
  const warnings: string[] = [];
  const css = cssSources(html);
  const known = new Set([...ctx.tokens.map((t) => t.name), ...ctx.tweaks.map((t) => t.cssVar)]);
  const local = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)].filter((m) => !m[2]).map((m) => m[1]!));
  const missing = [...used].filter((v) => !known.has(v) && !local.has(v));
  if (missing.length > 0) warnings.push(`引用了不存在的令牌：${missing.join('、')}（先用 read_design_system 看可用令牌）`);
  const hard = css.match(HARD_COLOR)?.length ?? 0;
  if (hard > 3) warnings.push(`有 ${hard} 处写死的颜色，优先改用设计令牌 var(--*)`);
  const allUsed = new Set([...html.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!));
  const idle = ctx.tweaks.filter((t) => !allUsed.has(t.cssVar)).map((t) => t.cssVar);
  if (idle.length > 0) warnings.push(`旋钮对应的变量没有被用到，拖动不会有效果：${idle.join('、')}`);
  const external = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:[^"']+)/gi)].map((m) => m[1]!).filter((src) => !DESIGN_SCRIPT_HOSTS.some((h) => src.startsWith(`${h}/`)));
  if (external.length > 0) warnings.push(`这些脚本会被预览沙箱拦截：${external.join('、')}`);
  if (/\bfetch\(|XMLHttpRequest|new WebSocket/.test(html)) warnings.push('预览沙箱没有网络，fetch / XHR / WebSocket 都会失败，请用内联的示例数据');
  return warnings;
}
