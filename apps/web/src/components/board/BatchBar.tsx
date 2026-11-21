import { TERMINAL, type TaskStatus } from '@aw/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import type { BoardTask } from '@/lib/queries';

// 多选状态：可选的只有本台未终态的任务；动作逐条顺序执行，失败聚合成一条提示
export function useBatch(wsId: string, tasks: BoardTask[]) {
  const qc = useQueryClient();
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const selectable = (t: BoardTask) => t.workstationId === wsId && !TERMINAL.includes(t.status as TaskStatus);
  const exit = () => {
    setActive(false);
    setPicked(new Set());
  };
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selected = tasks.filter((t) => picked.has(t.id));

  const run = async (label: string, fn: (t: BoardTask) => Promise<unknown>) => {
    setBusy(true);
    const fails: string[] = [];
    for (const t of selected) {
      try {
        await fn(t);
      } catch (e) {
        fails.push(`「${t.title}」${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(false);
    // 裸 api 调用不走 mutation 缓存，自己兜底刷新（实时流在时也会重推）
    void qc.invalidateQueries();
    if (fails.length === 0) toast(`${label}：${selected.length} 个任务已处理`, 'ok');
    else toast(`${label}：${fails.length} 个失败——${fails.slice(0, 3).join('；')}${fails.length > 3 ? ' 等' : ''}`);
    if (fails.length === 0) setPicked(new Set());
  };

  return { active, setActive, exit, picked, toggle, selectable, selected, busy, run };
}

const ON_INK = 'text-primary-ink hover:bg-[color-mix(in_oklab,var(--color-primary-ink)_14%,transparent)] hover:text-primary-ink active:bg-[color-mix(in_oklab,var(--color-primary-ink)_20%,transparent)]';

export function BatchBar({ batch }: { batch: ReturnType<typeof useBatch> }) {
  const [due, setDue] = useState('');
  const [confirm, setConfirm] = useState(false);

  const applyDue = () =>
    batch.run('设截止日期', async (t) => unwrap(await api.tasks[':id'].plan.$patch({ param: { id: t.id }, json: { dueAt: due } })));
  const cancelAll = () =>
    batch.run('取消任务', async (t) => unwrap(await api.tasks[':id'].transition.$post({ param: { id: t.id }, json: { event: 'cancel' } })));

  return (
    <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center px-4" data-testid="batch-bar">
      <div className="pointer-events-auto flex w-fit max-w-full animate-rise flex-wrap items-center gap-2 rounded-btn bg-primary py-1.5 pl-[18px] pr-1.5 text-sm text-primary-ink shadow-[var(--shadow-pop)]">
        <span className="mr-2 font-semibold tabular-nums">已选 {batch.selected.length}</span>
        <Input type="date" className="h-7 w-36 rounded-btn" value={due} onChange={(e) => setDue(e.target.value)} aria-label="截止日期" data-testid="batch-due" />
        <Button size="sm" variant="quiet" className={ON_INK} disabled={batch.selected.length === 0 || !due || batch.busy} onClick={applyDue} data-testid="batch-set-due">
          设截止日期
        </Button>
        <Button size="sm" variant="quiet" className={ON_INK} disabled={batch.selected.length === 0 || batch.busy} onClick={() => setConfirm(true)} data-testid="batch-cancel">
          取消任务
        </Button>
        <Button size="sm" onClick={batch.exit} data-testid="batch-exit">
          退出多选
        </Button>
      </div>
      {confirm && (
        <Dialog title="取消任务" onClose={() => setConfirm(false)} testId="batch-cancel-dialog">
          <DialogForm
            submitting={batch.busy}
            submitLabel={`取消 ${batch.selected.length} 个任务`}
            onSubmit={() => {
              setConfirm(false);
              void cancelAll();
            }}
            onCancel={() => setConfirm(false)}
          >
            <p className="text-sm text-ink-2">选中的 {batch.selected.length} 个任务都会被取消，这个操作不可撤销。</p>
          </DialogForm>
        </Dialog>
      )}
    </div>
  );
}
