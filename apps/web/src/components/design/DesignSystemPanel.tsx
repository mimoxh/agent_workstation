import { tokenGroup, type DesignToken, type TokenGroup } from '@aw/domain';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Page } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { ErrorState, Loading, MenuItem, Popover, toast } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useDesignSystem, useEntityVersions, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';

const GROUPS: { id: TokenGroup; label: string }[] = [
  { id: 'color', label: '颜色' },
  { id: 'font', label: '字体' },
  { id: 'size', label: '尺寸' },
  { id: 'shadow', label: '阴影' },
  { id: 'other', label: '其他' },
];

function ImportTokens({ ws, project, onClose }: { ws: WorkstationDetail; project: ProjectDetail; onClose: () => void }) {
  const repos = project.workstations.filter((w) => w.pluginId === 'dev');
  const [source, setSource] = useState<'css' | 'repo'>(repos.length > 0 ? 'repo' : 'css');
  const [css, setCss] = useState('');
  const [repo, setRepo] = useState(repos[0]?.id ?? '');
  const [path, setPath] = useState('');
  const run = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id']['design-system'].import.$post({ param: { id: ws.id }, json: source === 'css' ? { css } : { sourceWorkstationId: repo, path: path.trim() } })),
    onSuccess: (r) => {
      toast(`导入了 ${r.count} 个令牌`, 'ok');
      onClose();
    },
  });
  return (
    <Dialog title="导入令牌" onClose={onClose} testId="tokens-import-dialog">
      <DialogForm error={run.error?.message} submitting={run.isPending} submitLabel="导入" canSubmit={source === 'css' ? !!css.trim() : !!repo && !!path.trim()} onSubmit={() => run.mutate()} onCancel={onClose}>
        <Field label="来源">
          <Select value={source} onChange={(e) => setSource(e.target.value as 'css' | 'repo')} data-testid="tokens-source">
            {repos.length > 0 && <option value="repo">开发台的代码仓库</option>}
            <option value="css">粘贴 CSS</option>
          </Select>
        </Field>
        {source === 'css' ? (
          <Field label="CSS" hint="读取其中的自定义属性（--name: value）">
            <Textarea className="measured" rows={8} value={css} onChange={(e) => setCss(e.target.value)} data-testid="tokens-css" />
          </Field>
        ) : (
          <>
            <Field label="开发工作台">
              <Select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <Field label="样式文件" required hint="仓库内路径，读取其中的自定义属性">
              <Input className="measured" value={path} placeholder="apps/web/src/index.css" onChange={(e) => setPath(e.target.value)} data-testid="tokens-path" />
            </Field>
          </>
        )}
      </DialogForm>
    </Dialog>
  );
}

function History({ id }: { id: string }) {
  const versions = useEntityVersions(id);
  const rollback = useMutation({ mutationFn: async (version: number) => unwrap(await api.entities[':id'].rollback.$post({ param: { id }, json: { version } })) });
  return (
    <Popover className="max-h-[60vh] w-72 overflow-y-auto" trigger={(on, toggle) => <Button variant="quiet" aria-expanded={on} onClick={toggle}>版本</Button>}>
      {(close) => (versions.data ?? []).map((v, i) => (
        <MenuItem key={v.version} className="whitespace-normal" disabled={i === 0} onClick={() => { rollback.mutate(v.version); close(); }}>
          <span className="measured text-ink">v{v.version}</span><span className="ml-2 text-xs text-muted">{when(v.createdAt)}{i === 0 ? ' · 当前' : ' · 点击恢复'}</span>
          {v.reason && <span className="block text-xs text-muted">{v.reason}</span>}
        </MenuItem>
      ))}
    </Popover>
  );
}

export function DesignSystemPanel({ ws, project }: { ws: WorkstationDetail; project: ProjectDetail }) {
  const system = useDesignSystem(ws.id);
  const [tokens, setTokens] = useState<DesignToken[] | null>(null);
  const [guidelines, setGuidelines] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const data = system.data;
  const current = tokens ?? data?.tokens ?? [];
  const dirty = tokens !== null || guidelines !== null;

  // 设计师或导入改了服务端版本时，丢弃没有基于它的本地视图
  useEffect(() => {
    setTokens(null);
    setGuidelines(null);
  }, [data?.version]);

  const save = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id']['design-system'].$put({ param: { id: ws.id }, json: { ...(tokens ? { tokens } : {}), ...(guidelines !== null ? { guidelines } : {}), ...(data?.id ? { baseVersion: data.version } : {}) } })),
    onSuccess: () => {
      setTokens(null);
      setGuidelines(null);
    },
  });

  const grouped = useMemo(() => GROUPS.map((g) => ({ ...g, items: current.map((t, i) => ({ t, i })).filter(({ t }) => tokenGroup(t) === g.id) })).filter((g) => g.items.length > 0), [current]);
  const change = (i: number, value: string) => setTokens(current.map((t, k) => (k === i ? { ...t, value } : t)));
  const remove = (i: number) => setTokens(current.filter((_, k) => k !== i));
  const add = () => setTokens([...current, { name: `--new-${current.length + 1}`, value: '#000000' }]);
  const rename = (i: number, name: string) => setTokens(current.map((t, k) => (k === i ? { ...t, name } : t)));

  if (system.isError) return <ErrorState error={system.error} onRetry={() => void system.refetch()} />;
  if (!data) return <Loading />;

  return (
    <div className="h-full overflow-y-auto" data-testid="design-system">
      <Page>
        <div className="sticky top-0 z-10 -mx-2 flex items-center gap-2 bg-paper px-2 py-2">
          <p className="min-w-0 flex-1 text-sm text-muted">{data.name}。令牌注入到所有设计稿，改了立即生效。</p>
          {data.id && <History id={data.id} />}
          <Button onClick={() => setImporting(true)} data-testid="tokens-import">导入</Button>
          <Button onClick={add} data-testid="tokens-add">添加</Button>
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="tokens-save">保存</Button>
        </div>
        <div className="space-y-6 pt-2">
          {grouped.map((g) => (
            <section key={g.id} aria-label={g.label}>
              <h3 className="mb-2 text-sm font-semibold text-ink-2">{g.label}</h3>
              <ul className="space-y-1">
                {g.items.map(({ t, i }) => (
                  <li key={i} className="group flex items-center gap-2" data-testid="token-row">
                    {g.id === 'color' && (/^#[0-9a-f]{6}$/i.test(t.value)
                      ? <input type="color" aria-label={`${t.name} 色值`} value={t.value} onChange={(e) => change(i, e.target.value)} className="size-8 shrink-0 cursor-pointer rounded-pill border border-rule-2 bg-paper p-0.5" />
                      : <span aria-hidden className="size-8 shrink-0 rounded-pill border border-rule-2" style={{ background: t.value }} />)}
                    {g.id === 'font' && <span aria-hidden className="w-8 shrink-0 text-center text-title text-ink" style={{ fontFamily: t.value }}>字</span>}
                    {g.id === 'shadow' && <span aria-hidden className="size-8 shrink-0 rounded-pill bg-paper" style={{ boxShadow: t.value }} />}
                    <Input className="measured w-56 shrink-0" aria-label="令牌名" value={t.name} onChange={(e) => rename(i, e.target.value)} />
                    <Input className="measured min-w-0 flex-1" aria-label={`${t.name} 的值`} value={t.value} onChange={(e) => change(i, e.target.value)} data-testid="token-value" />
                    <Button size="sm" variant="quiet" aria-label={`删除 ${t.name}`} onClick={() => remove(i)}>删除</Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <Field label="设计规范" hint="写给设计师看的约定：调性、禁区、组件用法">
            <Textarea rows={8} value={guidelines ?? data.guidelines} onChange={(e) => setGuidelines(e.target.value)} data-testid="tokens-guidelines" />
          </Field>
        </div>
      </Page>
      {importing && <ImportTokens ws={ws} project={project} onClose={() => setImporting(false)} />}
    </div>
  );
}
