// 文档台的纯函数：大纲、脚注引用、按风格指南的 lint、交接门禁。服务端校验和前端预览共用一份

export type DocStatus = 'draft' | 'reviewing' | 'approved' | 'handed_off' | 'published' | 'stale';

export interface StyleTerm {
  term: string;
  preferred: string;
  avoid: string[];
}

export interface DocLintConfig {
  maxHeadingDepth?: number;
  maxSentenceChars?: number;
  bannedWords?: string[];
  requiredSections?: string[];
}

export interface LintIssue {
  level: 'error' | 'warn';
  rule: 'term' | 'banned' | 'heading_depth' | 'heading_skip' | 'required_section' | 'sentence_length' | 'citation_missing' | 'citation_unused';
  message: string;
  line: number;
}

export interface OutlineItem {
  depth: number;
  text: string;
  line: number;
}

export type CitationDriftStatus = 'unchanged' | 'moved' | 'changed' | 'deleted';

// 引用片段与现文件的比对：文件没了 → deleted；原行段还匹配 → unchanged；
// 等长窗口滑过全文先命中者 → moved 并给新行号；都不中 → changed
export function classifyCitationDrift(i: { fileLines: string[] | null; lines: [number, number]; matches: (snippet: string) => boolean }): { status: CitationDriftStatus; newLines?: [number, number] } {
  if (!i.fileLines) return { status: 'deleted' };
  const len = i.lines[1] - i.lines[0] + 1;
  if (len <= 0) return { status: 'changed' };
  if (i.lines[1] <= i.fileLines.length && i.matches(i.fileLines.slice(i.lines[0] - 1, i.lines[1]).join('\n'))) return { status: 'unchanged' };
  for (let s = 0; s + len <= i.fileLines.length; s++) {
    if (i.matches(i.fileLines.slice(s, s + len).join('\n'))) return { status: 'moved', newLines: [s + 1, s + len] };
  }
  return { status: 'changed' };
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`[^`]*`/g;
const FOOTNOTE_DEF = /^\s*\[\^[^\]]+\]\s*:/;
const FOOTNOTE_REF = /\[\^([^\]]+)\]/g;
const SENTENCE_END = /[^。！？.!?\n]+[。！？.!?]*/g;

// 围栏代码块内不作任何文本检查；inline code 按行剥掉
function* textLines(content: string): Generator<{ line: number; text: string; raw: string }> {
  let fenced = false;
  let fenceMark = '';
  for (const [i, raw] of content.split('\n').entries()) {
    const fence = FENCE.exec(raw);
    if (fence) {
      if (!fenced) {
        fenced = true;
        fenceMark = fence[1]!;
      } else if (raw.trimStart().startsWith(fenceMark)) {
        fenced = false;
      }
      continue;
    }
    if (!fenced) yield { line: i + 1, text: raw.replace(INLINE_CODE, ''), raw };
  }
}

export function outline(content: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const { line, raw } of textLines(content)) {
    const m = HEADING.exec(raw);
    if (m) out.push({ depth: m[1]!.length, text: m[2]!.replace(/#+\s*$/, '').trim(), line });
  }
  return out;
}

// 正文里的 [^id] 脚注标记：去重保序；定义行 `[^id]: ...` 不是引用
export function citationRefs(content: string): string[] {
  const out: string[] = [];
  for (const { text, raw } of textLines(content)) {
    if (FOOTNOTE_DEF.test(raw)) continue;
    for (const m of text.matchAll(FOOTNOTE_REF)) {
      const id = m[1]!.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

// 交接 / 导出时的成品渲染：strip 去掉脚注标记与定义行，footnotes 把登记引用落成脚注定义；
// 围栏代码块与 inline code 里的文本一律不动
export function renderForRepo(content: string, citations: { id: string; label: string }[], mode: 'strip' | 'footnotes'): string {
  const labels = new Map(citations.map((c) => [c.id, c.label]));
  const DEF = /^\s*\[\^([^\]]+)\]\s*:/;
  const stripLine = (line: string) =>
    line
      .split(/(`[^`]*`)/)
      .map((seg) => (seg.startsWith('`') && seg.endsWith('`') ? seg : seg.replace(/ ?\[\^[^\]]+\]/g, '')))
      .join('');
  const out: string[] = [];
  let fenced = false;
  let fenceMark = '';
  for (const raw of content.split('\n')) {
    const fence = FENCE.exec(raw);
    if (fence) {
      if (!fenced) {
        fenced = true;
        fenceMark = fence[1]!;
      } else if (raw.trimStart().startsWith(fenceMark)) {
        fenced = false;
      }
      out.push(raw);
      continue;
    }
    if (fenced) {
      out.push(raw);
      continue;
    }
    const def = DEF.exec(raw);
    if (def) {
      // strip 删掉全部定义行；footnotes 只删登记过 id 的旧定义，后面统一重写
      if (mode === 'strip' || labels.has(def[1]!.trim())) continue;
      out.push(raw);
      continue;
    }
    out.push(mode === 'strip' ? stripLine(raw) : raw);
  }
  let text = out.join('\n');
  if (mode === 'footnotes') {
    const defs = citationRefs(content)
      .filter((id) => labels.has(id))
      .map((id) => `[^${id}]: ${labels.get(id)!}`);
    if (defs.length > 0) text = `${text.trimEnd()}\n\n${defs.join('\n')}`;
  }
  return text;
}

// 引文比对的最小规整：行尾去空白、空白串压成一格、丢空行
export function normalizeSnippet(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd().replace(/\s+/g, ' '))
    .filter((l) => l !== '' && l !== ' ')
    .join('\n');
}

const MAX_DEPTH = 4;
const MAX_SENTENCE = 120;

export function lintDoc(content: string, guide: { terms?: StyleTerm[]; lint?: DocLintConfig }, citationIds: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const lint = guide.lint ?? {};
  const maxDepth = lint.maxHeadingDepth ?? MAX_DEPTH;
  const maxSentence = lint.maxSentenceChars ?? MAX_SENTENCE;
  const banned = new Set(lint.bannedWords ?? []);
  const avoid = (guide.terms ?? []).flatMap((t) => (t.avoid ?? []).map((a) => ({ bad: a, good: t.preferred || t.term })));
  const headings = outline(content);

  let prev = 0;
  for (const h of headings) {
    if (h.depth > maxDepth) issues.push({ level: 'warn', rule: 'heading_depth', message: `标题层级 H${h.depth} 超过上限 H${maxDepth}：${h.text}`, line: h.line });
    if (prev > 0 && h.depth > prev + 1) issues.push({ level: 'warn', rule: 'heading_skip', message: `标题层级从 H${prev} 跳到 H${h.depth}：${h.text}`, line: h.line });
    prev = h.depth;
  }
  for (const section of lint.requiredSections ?? []) {
    if (!headings.some((h) => h.text === section)) issues.push({ level: 'error', rule: 'required_section', message: `缺少必备章节：${section}`, line: 0 });
  }

  for (const { line, text } of textLines(content)) {
    for (const t of avoid) {
      if (t.bad && text.includes(t.bad)) issues.push({ level: 'warn', rule: 'term', message: `「${t.bad}」建议写作「${t.good}」`, line });
    }
    for (const w of banned) {
      if (w && text.includes(w)) issues.push({ level: 'error', rule: 'banned', message: `使用了禁用词「${w}」`, line });
    }
    for (const m of text.matchAll(SENTENCE_END)) {
      const s = m[0].trim();
      if (s.length > maxSentence) issues.push({ level: 'warn', rule: 'sentence_length', message: `句子过长（${s.length} 字，上限 ${maxSentence}）：${s.slice(0, 40)}…`, line });
    }
  }

  const refs = citationRefs(content);
  const ids = new Set(citationIds);
  for (const id of refs) {
    if (!ids.has(id)) issues.push({ level: 'error', rule: 'citation_missing', message: `脚注 [^${id}] 没有登记引用`, line: lineOf(content, id) });
  }
  for (const id of citationIds) {
    if (!refs.includes(id)) issues.push({ level: 'warn', rule: 'citation_unused', message: `引用 ${id} 已登记但正文没有用到`, line: 0 });
  }
  return issues;
}

function lineOf(content: string, id: string): number {
  for (const { line, text, raw } of textLines(content)) {
    if (FOOTNOTE_DEF.test(raw)) continue;
    if ([...text.matchAll(FOOTNOTE_REF)].some((m) => m[1]!.trim() === id)) return line;
  }
  return 0;
}

export function canHandoff(i: {
  reviewOk: boolean;
  reviewVerdict: 'pass' | 'fail' | null;
  lint: LintIssue[];
  openBlockingComments: number;
  targetRepo?: string | null;
  targetPath?: string | null;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.reviewVerdict === null) reasons.push('还没有事实核对结论');
  else if (!i.reviewOk) reasons.push('文档在核对后被改过，需要重新核对');
  else if (i.reviewVerdict === 'fail') reasons.push('事实核对未通过');
  const errors = i.lint.filter((x) => x.level === 'error').length;
  if (errors > 0) reasons.push(`${errors} 个 lint 错误`);
  if (i.openBlockingComments > 0) reasons.push(`${i.openBlockingComments} 条未解决的阻断评论`);
  if (!i.targetRepo || !i.targetPath) reasons.push('还没有设置目标仓库或目标路径');
  return { ok: reasons.length === 0, reasons };
}
