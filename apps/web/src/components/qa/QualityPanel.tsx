import { Empty } from '@/components/ui/feedback';
import { parseJson } from '@/lib/format';
import type { Block, ProjectDetail, WorkstationDetail } from '@/lib/queries';
import { Bugs } from './Bugs';
import { Cases } from './Cases';
import { Coverage } from './Coverage';
import { Flaky } from './Flaky';
import { Overview } from './Overview';
import { Plans } from './Plans';
import { Runs } from './Runs';
import { useQaNav, type QaProps } from './shared';

const VIEWS: Record<string, (p: QaProps) => React.JSX.Element> = { overview: Overview, runs: Runs, cases: Cases, plans: Plans, bugs: Bugs, flaky: Flaky, coverage: Coverage };

export function QualityPanel({ block, ws, project }: { block: Block; ws: WorkstationDetail; project: ProjectDetail }) {
  const { item, go } = useQaNav(ws, project);
  const View = VIEWS[parseJson<{ view?: string }>(block.configJson, {}).view ?? ''];
  if (!View) return <Empty title="未知的质量视图" />;
  return <View ws={ws} project={project} item={item} go={go} />;
}
