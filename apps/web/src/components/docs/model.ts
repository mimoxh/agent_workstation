import { outline } from '@aw/domain';
import { parseJson } from '@/lib/format';
import type { DocDetail } from '@/lib/queries';

export const DOC_KINDS = ['readme', 'api', 'guide', 'architecture', 'adr', 'release_notes', 'general'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const KIND_LABEL: Record<DocKind, string> = {
  readme: 'README',
  api: 'API 参考',
  guide: '指南',
  architecture: '架构',
  adr: 'ADR',
  release_notes: '发布说明',
  general: '通用',
};

export const kindLabel = (k: string | null | undefined): string => (k && k in KIND_LABEL ? KIND_LABEL[k as DocKind] : (k ?? '通用'));

export const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewing: '核对中',
  approved: '已核过',
  handed_off: '已交接',
  published: '已入库',
  stale: '已漂移',
};

export const STATUS_TONE: Record<string, 'neutral' | 'amber' | 'cool' | 'ok' | 'bad'> = {
  draft: 'neutral',
  reviewing: 'cool',
  approved: 'ok',
  handed_off: 'ok',
  published: 'ok',
  stale: 'amber',
};

export const FINDING_LABEL: Record<string, string> = {
  supported: '支撑',
  unsupported: '不支撑',
  outdated: '已过时',
  unverifiable: '无法核实',
};

export const FINDING_TONE: Record<string, 'ok' | 'bad' | 'amber' | 'neutral'> = {
  supported: 'ok',
  unsupported: 'bad',
  outdated: 'bad',
  unverifiable: 'amber',
};

export type OpenComment = DocDetail['openComments'][number];

export interface DocData {
  title?: string;
  kind?: string;
  brief?: string;
  target_repo?: string | null;
  target_path?: string | null;
  content?: string;
  citations?: DocDetail['citations'];
  status?: string;
  review?: DocDetail['review'];
}

export const docDataOf = (dataJson: string | null): DocData => parseJson<DocData>(dataJson, {});

// 选区评论带的章节：引文落在哪个标题下
export function headingBefore(content: string, quote: string): string {
  const idx = content.indexOf(quote);
  if (idx < 0) return '';
  const line = content.slice(0, idx).split('\n').length;
  return [...outline(content)].reverse().find((h) => h.line <= line)?.text ?? '';
}

export function commentsPrompt(docId: string, title: string, comments: OpenComment[]): string {
  const lines = comments.map((c, i) => `${i + 1}. comment id: ${c.id} · ${c.heading ? `「${c.heading}」` : ''}${c.quote ? `（原文：${c.quote.slice(0, 60)}）` : ''}：${c.body}`);
  return [`请处理文档「${title}」上的 ${comments.length} 条评论（doc: ${docId}）：`, ...lines].join('\n');
}
