import type { StyleTerm } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useStyleGuide, type StyleGuide, type WorkstationDetail } from '@/lib/queries';

interface LintForm {
  maxHeadingDepth: string;
  maxSentenceChars: string;
  bannedWords: string;
  requiredSections: string;
}

const toLintForm = (lint: NonNullable<StyleGuide['lint']> | undefined): LintForm => ({
  maxHeadingDepth: lint?.maxHeadingDepth !== undefined ? String(lint.maxHeadingDepth) : '',
  maxSentenceChars: lint?.maxSentenceChars !== undefined ? String(lint.maxSentenceChars) : '',
  bannedWords: (lint?.bannedWords ?? []).join('\n'),
  requiredSections: (lint?.requiredSections ?? []).join('\n'),
});

export function StyleGuidePanel({ ws }: { ws: WorkstationDetail }) {
  const guide = useStyleGuide(ws.id);
  const [terms, setTerms] = useState<StyleTerm[]>([]);
  const [rules, setRules] = useState('');
  const [lint, setLint] = useState<LintForm>(toLintForm(undefined));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (guide.data && !loaded) {
      setTerms(guide.data.terms ?? []);
      setRules(guide.data.rules ?? '');
      setLint(toLintForm(guide.data.lint));
      setLoaded(true);
    }
  }, [guide.data, loaded]);

  const save = useMutation({
    mutationFn: async () => {
      const num = (s: string) => (s.trim() ? Number(s.trim()) : undefined);
      const list = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
      const lintCfg = {
        ...(num(lint.maxHeadingDepth) !== undefined ? { maxHeadingDepth: num(lint.maxHeadingDepth) } : {}),
        ...(num(lint.maxSentenceChars) !== undefined ? { maxSentenceChars: num(lint.maxSentenceChars) } : {}),
        bannedWords: list(lint.bannedWords),
        requiredSections: list(lint.requiredSections),
      };
      return unwrap(
        await api.workstations[':id']['style-guide'].$put({
          param: { id: ws.id },
          json: { name: '风格指南', terms, rules, lint: lintCfg, ...(guide.data?.version ? { baseVersion: guide.data.version } : {}) },
        }),
      );
    },
  });

  if (!guide.data) return guide.isError ? <Empty title="风格指南加载失败" /> : <Loading className="flex-1" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="style-guide">
      <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper px-4 py-2">
        <h2 className="text-sm font-medium">风格指南</h2>
        <span className="text-xs text-muted">主笔写作、文字编辑检查时都按这份来</span>
        <Button variant="primary" size="sm" className="ml-auto" disabled={save.isPending} onClick={() => save.mutate()} data-testid="style-save">
          保存
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">术语表</h3>
            <Button size="sm" variant="quiet" onClick={() => setTerms((t) => [...t, { term: '', preferred: '', avoid: [] }])} data-testid="term-add">
              <Icon name="plus" className="size-3.5" />加术语
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {terms.length === 0 ? <p className="text-sm text-muted">还没有术语。例如：「工作台」统一写「工作台」，别写「工作站」。</p> : null}
            {terms.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-1.5" data-testid={`term-row-${i}`}>
                <Input value={t.term} placeholder="术语" onChange={(e) => setTerms((all) => all.map((x, j) => (j === i ? { ...x, term: e.target.value } : x)))} data-testid={`term-name-${i}`} />
                <Input value={t.preferred} placeholder="推荐写法" onChange={(e) => setTerms((all) => all.map((x, j) => (j === i ? { ...x, preferred: e.target.value } : x)))} data-testid={`term-preferred-${i}`} />
                <Input
                  value={t.avoid.join('，')}
                  placeholder="避免的写法（逗号分隔）"
                  onChange={(e) => setTerms((all) => all.map((x, j) => (j === i ? { ...x, avoid: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) } : x)))}
                  data-testid={`term-avoid-${i}`}
                />
                <button type="button" aria-label="删除术语" className="grid size-7 place-items-center rounded-btn text-muted hover:bg-canvas hover:text-bad" onClick={() => setTerms((all) => all.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <Field label="行文规则（markdown）">
            <Textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={10} className="font-mono text-sm" data-testid="style-rules" placeholder="比如：标题用「名词短语」，不写「的」字结尾……" />
          </Field>
        </section>
        <section className="flex min-h-0 flex-col gap-2">
          <h3 className="text-sm font-medium">机器检查（lint）</h3>
          <div className="grid grid-cols-2 gap-2">
            <Field label="最大标题层级" hint="默认 4">
              <Input value={lint.maxHeadingDepth} onChange={(e) => setLint((l) => ({ ...l, maxHeadingDepth: e.target.value }))} inputMode="numeric" data-testid="lint-max-depth" />
            </Field>
            <Field label="最长句子字数" hint="默认 120">
              <Input value={lint.maxSentenceChars} onChange={(e) => setLint((l) => ({ ...l, maxSentenceChars: e.target.value }))} inputMode="numeric" data-testid="lint-max-sentence" />
            </Field>
          </div>
          <Field label="禁用词（每行一个）" hint="出现即报错">
            <Textarea value={lint.bannedWords} onChange={(e) => setLint((l) => ({ ...l, bannedWords: e.target.value }))} rows={6} className="font-mono text-sm" data-testid="lint-banned" />
          </Field>
          <Field label="必备章节（每行一个标题）" hint="缺一个即报错，按标题文字匹配">
            <Textarea value={lint.requiredSections} onChange={(e) => setLint((l) => ({ ...l, requiredSections: e.target.value }))} rows={6} className="font-mono text-sm" data-testid="lint-required" />
          </Field>
        </section>
      </div>
    </div>
  );
}
