import { TERMINAL, type TaskStatus } from '@aw/domain';
import { moduleOf } from '@/components/board/TaskCard';
import { EntityPanel, type EntityDef } from '@/components/panels/EntityPanel';
import { Badge } from '@/components/ui/badge';
import { parseJson } from '@/lib/format';
import { useWsTasks, type BoardTask, type EntityRow, type WorkstationDetail } from '@/lib/queries';

const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '.';
// 前缀包含就算重叠（任一向）；任务声明 . 表示全仓库，计进所有模块
const overlaps = (scope: string, mod: string) => {
  const a = norm(scope);
  const b = norm(mod);
  if (a === '.') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
const scopesOf = (t: BoardTask) => (moduleOf(t) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const openOn = (tasks: BoardTask[] | undefined, modPath: string) =>
  (tasks ?? []).filter((t) => !TERMINAL.includes(t.status as TaskStatus) && scopesOf(t).some((s) => overlaps(s, modPath))).length;

// 模块登记：每行多一枚「进行中任务」计数——范围前缀相交的任务归到这个 Module 名下
export function ModulesPanel({ ws, def, editable }: { ws: WorkstationDetail; def: EntityDef; editable: boolean }) {
  const tasks = useWsTasks(ws.id);
  return (
    <EntityPanel
      wsId={ws.id}
      entityType="Module"
      def={def}
      editable={editable}
      rowExtra={(row: EntityRow) => {
        const path = String(parseJson<{ path?: string }>(row.dataJson, {}).path ?? '');
        const n = openOn(tasks.data, path);
        return <Badge tone={n > 0 ? 'cool' : 'neutral'} data-testid="module-open-count">{n} 个进行中任务</Badge>;
      }}
      emptyExtra={<p className="text-xs text-muted">架构师接单时会自动登记任务涉及的 Module，你也可以手动新建。登记后，范围不在任何 Module 下的任务会在设计阶段要求 ADR</p>}
    />
  );
}
