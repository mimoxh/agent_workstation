import type { StyleTerm } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Spinner } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
    <div className="h-full min-h-0 overflow-y-auto" data-testid="style-guide">
      <div className="px-5 pb-14 md:px-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-4">
          <h2 className="text-sm font-bold text-ink">风格指南</h2>
          <span className="text-sm text-muted">主笔写作、文字编辑检查时都按这份来</span>
          <Button variant="primary" size="sm" className="ml-auto" disabled={save.isPending} aria-busy={save.isPending || undefined} onClick={() => save.mutate()} data-testid="style-save">
            {save.isPending ? <Spinner /> : <Icon name="check" />}保存
          </Button>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="grid gap-4">
            <Card className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-ink">术语表</h3>
                <Button size="sm" variant="quiet" className="ml-auto" onClick={() => setTerms((t) => [...t, { term: '', preferred: '', avoid: [] }])} data-testid="term-add">
                  <Icon name="plus" />加术语
                </Button>
              </div>
              {terms.length === 0 ? <p className="text-sm text-muted">还没有术语。例如：「工作台」统一写「工作台」，别写「工作站」。</p> : (
                <div className="overflow-x-auto">
                  <div className="grid min-w-[30rem] gap-2">
                    <div aria-hidden className="grid grid-cols-[1fr_1fr_1.2fr_1.75rem] gap-2 text-xs font-semibold text-muted">
                      <span>术语</span><span>推荐写法</span><span>避免的写法</span><span />
                    </div>
                    {terms.map((t, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_1.2fr_1.75rem] items-center gap-2" data-testid={`term-row-${i}`}>
                        <Input className="h-8" value={t.term} placeholder="术语" onChange={(e) => setTerms((all) => all.map((x, j) => (j === i ? { ...x, term: e.target.value } : x)))} data-testid={`term-name-${i}`} />
                        <Input className="h-8" value={t.preferred} placeholder="推荐写法" onChange={(e) => setTerms((all) => all.map((x, j) => (j === i ? { ...x, preferred: e.target.value } : x)))} data-testid={`term-preferred-${i}`} />
                        <Input
                          className="h-8"
                          value={t.avoid.join('，')}
                          placeholder="避免的写法（逗号分隔）"
                          onChange={(e) => setTerms((all) => all.map((x, j) => (j === i ? { ...x, avoid: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) } : x)))}
                          data-testid={`term-avoid-${i}`}
                        />
                        <Button size="icon-sm" variant="quiet" aria-label="删除术语" className="hover:text-bad" onClick={() => setTerms((all) => all.filter((_, j) => j !== i))}>
                          <Icon name="trash" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
            <Card className="grid gap-3 p-4">
              <Field label="行文规则（markdown）">
                <Textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={10} className="font-mono text-[13px]" data-testid="style-rules" placeholder="比如：标题用「名词短语」，不写「的」字结尾……" />
              </Field>
            </Card>
          </div>
          <Card className="grid gap-4 p-4">
            <h3 className="text-sm font-bold text-ink">机器检查（lint）</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="最大标题层级" hint="默认 4">
                <Input className="num" value={lint.maxHeadingDepth} onChange={(e) => setLint((l) => ({ ...l, maxHeadingDepth: e.target.value }))} inputMode="numeric" data-testid="lint-max-depth" />
              </Field>
              <Field label="最长句子字数" hint="默认 120">
                <Input className="num" value={lint.maxSentenceChars} onChange={(e) => setLint((l) => ({ ...l, maxSentenceChars: e.target.value }))} inputMode="numeric" data-testid="lint-max-sentence" />
              </Field>
            </div>
            <Field label="禁用词（每行一个）" hint="出现即报错">
              <Textarea value={lint.bannedWords} onChange={(e) => setLint((l) => ({ ...l, bannedWords: e.target.value }))} rows={6} className="font-mono text-[13px]" data-testid="lint-banned" />
            </Field>
            <Field label="必备章节（每行一个标题）" hint="缺一个即报错，按标题文字匹配">
              <Textarea value={lint.requiredSections} onChange={(e) => setLint((l) => ({ ...l, requiredSections: e.target.value }))} rows={6} className="font-mono text-[13px]" data-testid="lint-required" />
            </Field>
          </Card>
        </div>
      </div>
    </div>
  );
}
