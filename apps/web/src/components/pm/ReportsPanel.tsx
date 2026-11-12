import { useMutation } from '@tanstack/react-query';
import { EntityPanel, type EntityDef } from '@/components/panels/EntityPanel';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/feedback';
import { api, unwrap } from '@/lib/api';
import type { ProjectDetail, WorkstationDetail } from '@/lib/queries';

// 进展报告板块：列表走实体板块，头部多一个「请项目经理生成」——往根台大群发话
export function ReportsPanel({ ws, project, def, editable }: { ws: WorkstationDetail; project: ProjectDetail; def: EntityDef; editable: boolean }) {
  const root = project.workstations.find((w) => w.parentId === null);
  const ask = useMutation({
    mutationFn: async () => {
      const th = await unwrap(await api.workstations[':id'].thread.$get({ param: { id: root!.id } }));
      return unwrap(await api.threads[':id'].messages.$post({ param: { id: th.thread.id }, json: { content: '@项目经理 请生成一份最新的进展报告' } }));
    },
    onSuccess: () => toast('已在大群请项目经理生成进展报告', 'ok'),
  });
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="reports-panel">
      <div className="flex items-center justify-between gap-3 px-6 pt-4">
        <p className="text-sm text-muted">项目经理按项目现状起草的报告存档在这里</p>
        <Button size="sm" variant="primary" disabled={!root || ask.isPending} onClick={() => ask.mutate()} data-testid="report-ask">
          请项目经理生成
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <EntityPanel wsId={ws.id} entityType="StatusReport" def={def} editable={editable} />
      </div>
    </div>
  );
}
