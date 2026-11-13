import { describe, expect, it } from 'vitest';
import { canHandoff, citationRefs, classifyCitationDrift, lintDoc, normalizeSnippet, outline, renderForRepo } from '../src/docs.js';

describe('outline', () => {
  it('按行号给出标题层级，代码块里的 # 不算', () => {
    const md = ['# 标题', '正文', '## 小节', '```', '# 假标题', '```', '#### 深标题'].join('\n');
    expect(outline(md)).toEqual([
      { depth: 1, text: '标题', line: 1 },
      { depth: 2, text: '小节', line: 3 },
      { depth: 4, text: '深标题', line: 7 },
    ]);
  });
});

describe('citationRefs', () => {
  it('去重保序；定义行和代码里的标记不算', () => {
    const md = ['见 [^a] 和 [^b]。', '再说一次 [^a]。', '[^c]: 这是定义不是引用', '`[^d]` 行内代码', '```', '[^e]', '```'].join('\n');
    expect(citationRefs(md)).toEqual(['a', 'b']);
  });
});

describe('normalizeSnippet', () => {
  it('行尾去空白、空白串压一格、丢空行', () => {
    expect(normalizeSnippet('a  b   \n\n\n  c\td ')).toBe('a b\n c d');
  });
});

describe('lintDoc', () => {
  const guide = {
    terms: [{ term: '工作台', preferred: '工作台', avoid: ['工作区', '工作站'] }],
    lint: { bannedWords: ['强大'], maxHeadingDepth: 3, maxSentenceChars: 20, requiredSections: ['用法'] },
  };

  it('术语、禁用词、标题层级、必备章节', () => {
    const md = ['# 用法', '这是工作站，非常强大。', '### ok', '##### 太深了'].join('\n');
    const issues = lintDoc(md, guide, []);
    expect(issues).toContainEqual({ level: 'warn', rule: 'term', message: '「工作站」建议写作「工作台」', line: 2 });
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', rule: 'banned', line: 2 }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warn', rule: 'heading_depth', line: 4 }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warn', rule: 'heading_skip', line: 4 }));
    expect(issues.filter((i) => i.rule === 'required_section')).toHaveLength(0);
  });

  it('缺必备章节报 error；长句报 warn；代码块不算', () => {
    const md = ['# 其它', '这是一句特别特别特别特别特别特别特别长的话。', '```', '工作站 强大', '```'].join('\n');
    const issues = lintDoc(md, guide, []);
    expect(issues).toContainEqual({ level: 'error', rule: 'required_section', message: '缺少必备章节：用法', line: 0 });
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warn', rule: 'sentence_length', line: 2 }));
    expect(issues.filter((i) => i.rule === 'banned')).toHaveLength(0);
    expect(issues.filter((i) => i.rule === 'term')).toHaveLength(0);
  });

  it('脚注没登记报 error，登记了没用报 warn', () => {
    const md = '引用一 [^a]，引用二 [^x]。';
    const issues = lintDoc(md, {}, ['a', 'b']);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', rule: 'citation_missing' }));
    expect(issues.filter((i) => i.rule === 'citation_missing')).toHaveLength(1);
    expect(issues).toContainEqual({ level: 'warn', rule: 'citation_unused', message: '引用 b 已登记但正文没有用到', line: 0 });
  });
});

describe('renderForRepo', () => {
  const cites = [
    { id: 'a', label: '`src/a.ts` 第 1–3 行' },
    { id: 'b', label: '《词汇》：统一写作' },
  ];

  it('strip：去掉标记（含前一个空格）和所有定义行，代码里不动', () => {
    const md = ['见 [^a] 与 [^b]。', '行内 `[^a]` 保留', '```', '[^a] 代码里', '```', '[^a]: 旧定义', '[^b]: 旧定义二', '尾行'].join('\n');
    expect(renderForRepo(md, cites, 'strip')).toBe(['见 与。', '行内 `[^a]` 保留', '```', '[^a] 代码里', '```', '尾行'].join('\n'));
  });

  it('strip：正文标记清干净，未登记标记同样去掉', () => {
    expect(renderForRepo('甲 [^a] 乙[^b] 丙 [^x]', cites, 'strip')).toBe('甲 乙 丙');
  });

  it('footnotes：按引用顺序重写定义行，未登记的不重写', () => {
    const md = ['见 [^b] 再 [^a]，还有 [^x]。', '[^a]: 旧定义要被替换', '[^z]: 没登记的保留'].join('\n');
    expect(renderForRepo(md, cites, 'footnotes')).toBe(['见 [^b] 再 [^a]，还有 [^x]。', '[^z]: 没登记的保留', '', '[^b]: 《词汇》：统一写作', '[^a]: `src/a.ts` 第 1–3 行'].join('\n'));
  });

  it('footnotes：代码块里的标记不生成定义', () => {
    const md = ['```', '[^a]', '```'].join('\n');
    expect(renderForRepo(md, cites, 'footnotes')).toBe(md);
  });
});

describe('classifyCitationDrift', () => {
  const file = ['a1', 'a2', 'b1', 'b2', 'b3', 'c1'];
  const matches = (snippet: string) => snippet === 'b1\nb2\nb3';

  it('文件没了 → deleted', () => {
    expect(classifyCitationDrift({ fileLines: null, lines: [3, 5], matches })).toEqual({ status: 'deleted' });
  });

  it('原行段仍匹配 → unchanged（文件其它地方动过无妨）', () => {
    expect(classifyCitationDrift({ fileLines: [...file, 'y'], lines: [3, 5], matches })).toEqual({ status: 'unchanged' });
    expect(classifyCitationDrift({ fileLines: file, lines: [3, 5], matches })).toEqual({ status: 'unchanged' });
  });

  it('片段挪位 → moved + 新行号', () => {
    expect(classifyCitationDrift({ fileLines: ['new1', 'new2', ...file], lines: [3, 5], matches })).toEqual({ status: 'moved', newLines: [5, 7] });
  });

  it('片段被改 → changed', () => {
    expect(classifyCitationDrift({ fileLines: ['a1', 'a2', 'x', 'y', 'z', 'c1'], lines: [3, 5], matches })).toEqual({ status: 'changed' });
  });

  it('文件变短容不下片段 → changed', () => {
    expect(classifyCitationDrift({ fileLines: ['a1'], lines: [3, 5], matches })).toEqual({ status: 'changed' });
  });
});

describe('canHandoff', () => {
  const lint = (level: 'error' | 'warn') => ({ level, rule: 'banned' as const, message: 'x', line: 1 });

  it('全部满足才放行', () => {
    expect(canHandoff({ reviewOk: true, reviewVerdict: 'pass', lint: [], openBlockingComments: 0, targetRepo: 'r', targetPath: 'p' })).toEqual({ ok: true, reasons: [] });
  });

  it('逐条列出原因', () => {
    const r = canHandoff({ reviewOk: false, reviewVerdict: null, lint: [lint('error'), lint('warn')], openBlockingComments: 2 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['还没有事实核对结论', '1 个 lint 错误', '2 条未解决的阻断评论', '还没有设置目标仓库或目标路径']);
  });

  it('核对后改过 / 核对未通过', () => {
    expect(canHandoff({ reviewOk: false, reviewVerdict: 'pass', lint: [], openBlockingComments: 0, targetRepo: 'r', targetPath: 'p' }).reasons).toEqual(['文档在核对后被改过，需要重新核对']);
    expect(canHandoff({ reviewOk: true, reviewVerdict: 'fail', lint: [], openBlockingComments: 0, targetRepo: 'r', targetPath: 'p' }).reasons).toEqual(['事实核对未通过']);
  });
});
