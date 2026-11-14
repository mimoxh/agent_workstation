import { composeDesignDoc, DESIGN_CSP, tweakCssValue, type DesignToken, type DesignTweak } from '@aw/domain';
import { parseJson } from '@/lib/format';
import type { EntityRow } from '@/lib/queries';
import { INSPECTOR_SCRIPT } from './inspector';

export type DesignStatus = 'draft' | 'approved' | 'handed_off';

export interface DesignData {
  title: string;
  html: string;
  brief?: string;
  group?: string;
  direction?: string;
  tweaks?: DesignTweak[];
  status?: DesignStatus;
  handoff?: { taskId: string; artifactId: string; version: number; workstationId: string };
  legacyTokens?: DesignToken[];
}

export interface DesignDoc { id: string; version: number; updatedAt: string | null; data: DesignData }

export interface CommentData { design: string; version?: number; selector?: string; anchor?: string; body: string; status?: 'open' | 'resolved'; note?: string }
export interface DesignComment extends CommentData { id: string; rowVersion: number; authorType: string | null; authorId: string | null; createdAt: string }

export type CanvasMode = 'view' | 'comment' | 'edit' | 'select';

export interface Pin { n: number; selector: string; active: boolean }

export interface SelectItem { selector: string; anchor: string; tag: string; html: string }

export type FrameEvent =
  | { type: 'pick'; selector: string; anchor: string; tag: string }
  | { type: 'edit'; selector: string; text: string }
  | { type: 'pin'; n: number }
  | { type: 'missing'; pins: number[] }
  | { type: 'issue'; text: string }
  | { type: 'select'; items: SelectItem[] };

export const toDesign = (e: EntityRow): DesignDoc => ({ id: e.id, version: e.version, updatedAt: e.updatedAt, data: parseJson<DesignData>(e.dataJson, { title: '', html: '' }) });

export const toComment = (e: EntityRow): DesignComment => ({ ...parseJson<CommentData>(e.dataJson, { design: '', body: '' }), id: e.id, rowVersion: e.version, authorType: e.createdByType, authorId: e.createdById, createdAt: e.createdAt });

export const STATUS_LABEL: Record<DesignStatus, string> = { draft: '草稿', approved: '已定稿', handed_off: '已交接' };

const inspectorHead = `<meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}"><script>${INSPECTOR_SCRIPT}</script>`;
const thumbHead = `<meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}">`;

export const previewDoc = (html: string, tokens: DesignToken[], tweaks: DesignTweak[]) => composeDesignDoc(html, { tokens, tweaks, head: inspectorHead });
export const thumbDoc = (html: string, tokens: DesignToken[], tweaks: DesignTweak[]) => composeDesignDoc(html, { tokens, tweaks, head: thumbHead });
export const exportDoc = (html: string, tokens: DesignToken[], tweaks: DesignTweak[]) => composeDesignDoc(html, { tokens, tweaks });

export const tweakVars = (tweaks: DesignTweak[], draft: Record<string, string>) =>
  Object.fromEntries(tweaks.map((t) => [t.cssVar, tweakCssValue({ ...t, value: draft[t.id] ?? t.value })]));

export function applyDraft(tweaks: DesignTweak[], draft: Record<string, string>): DesignTweak[] {
  return tweaks.map((t) => (draft[t.id] === undefined ? t : { ...t, value: draft[t.id]! }));
}

// 沙箱里的代码也能发消息：只接受形状正确的事件，后续只把内容当纯文本用
export function parseFrameEvent(d: unknown): FrameEvent | null {
  if (typeof d !== 'object' || d === null) return null;
  const m = d as Record<string, unknown>;
  if (m.aw !== 'design-frame') return null;
  if (m.type === 'pick' && typeof m.selector === 'string') return { type: 'pick', selector: m.selector.slice(0, 2000), anchor: String(m.anchor ?? '').slice(0, 80), tag: String(m.tag ?? '').slice(0, 40) };
  if (m.type === 'edit' && typeof m.selector === 'string' && typeof m.text === 'string') return { type: 'edit', selector: m.selector.slice(0, 2000), text: m.text.slice(0, 20000) };
  if (m.type === 'pin' && typeof m.n === 'number') return { type: 'pin', n: m.n };
  if (m.type === 'missing' && Array.isArray(m.pins)) return { type: 'missing', pins: m.pins.filter((p): p is number => typeof p === 'number') };
  if (m.type === 'issue' && typeof m.text === 'string') return { type: 'issue', text: m.text.slice(0, 300) };
  if (m.type === 'select' && Array.isArray(m.items)) {
    const items = m.items.slice(0, 8).flatMap((i): SelectItem[] => {
      if (typeof i !== 'object' || i === null) return [];
      const it = i as Record<string, unknown>;
      if (typeof it.selector !== 'string' || typeof it.anchor !== 'string' || typeof it.tag !== 'string' || typeof it.html !== 'string') return [];
      return [{ selector: it.selector.slice(0, 2000), anchor: it.anchor.slice(0, 60), tag: it.tag.slice(0, 40), html: it.html.slice(0, 1500) }];
    });
    return { type: 'select', items };
  }
  return null;
}

export function commentsPrompt(designId: string, comments: DesignComment[]): string {
  const lines = comments.map((c, i) => {
    const where = c.selector ? `元素 \`${c.selector}\`${c.anchor ? `（「${c.anchor}」）` : ''}` : '整页';
    return `${i + 1}. comment id: ${c.id} · ${where}：${c.body}`;
  });
  return [`请处理这份设计稿上的 ${comments.length} 条评论（design: ${designId}）：`, ...lines].join('\n');
}

export function issuesPrompt(issues: string[]): string {
  return ['预览这份设计稿时出现这些问题，请修复：', ...issues.map((t) => `- ${t}`)].join('\n');
}

// 就地改字：解析稿子原文，只动一个元素的文本；脚本渲染出来的元素在原文里找不到，会明确失败
export function applyElementText(html: string, selector: string, text: string): { ok: true; html: string } | { ok: false; error: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let el: Element | null;
  try {
    el = doc.querySelector(selector);
  } catch {
    el = null;
  }
  if (!el) return { ok: false, error: '这段文字是脚本渲染的，不能直接改。用评论告诉设计师吧' };
  el.textContent = text;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].trim() ?? '<!doctype html>';
  return { ok: true, html: `${doctype}\n${doc.documentElement.outerHTML}` };
}

export const downloadName = (title: string, version: number) => `${title.replace(/[\\/:*?"<>|\s]+/g, '-') || 'design'}-v${version}.html`;

// 对比模式的设计候选：当前稿在最前，同一方案组里的其它方向跟在后面
export function compareDesigns<T extends { id: string; data: { group?: string | undefined } }>(designs: T[], currentId: string): T[] {
  const cur = designs.find((d) => d.id === currentId);
  const mates = cur?.data.group ? designs.filter((d) => d.id !== currentId && d.data.group === cur.data.group) : [];
  return cur ? [cur, ...mates] : mates;
}
