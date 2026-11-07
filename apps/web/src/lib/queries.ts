import { useQueries, useQuery } from '@tanstack/react-query';
import { api, unwrap } from './api';

const fetchProjects = async () => unwrap(await api.projects.$get());
const fetchProject = async (id: string) => unwrap(await api.projects[':id'].$get({ param: { id } }));
const fetchOverview = async (id: string) => unwrap(await api.projects[':id'].overview.$get({ param: { id } }));
const fetchProjectTasks = async (id: string) => unwrap(await api.projects[':id'].tasks.$get({ param: { id } }));
const fetchProjectRuns = async (id: string) => unwrap(await api.projects[':id'].runs.$get({ param: { id } }));
const fetchWorkstation = async (id: string) => unwrap(await api.workstations[':id'].$get({ param: { id } }));
const fetchWsTasks = async (id: string) => unwrap(await api.workstations[':id'].tasks.$get({ param: { id } }));
const fetchWsProposals = async (id: string) => unwrap(await api.workstations[':id'].proposals.$get({ param: { id } }));
const fetchWsTestRuns = async (id: string) => unwrap(await api.workstations[':id'].testruns.$get({ param: { id } }));
const fetchWsEntities = async (id: string) => unwrap(await api.workstations[':id'].entities.$get({ param: { id } }));
const fetchAgentStatus = async (id: string) => unwrap(await api.workstations[':id'].agents.status.$get({ param: { id } }));
const fetchRepoStatus = async (id: string) => unwrap(await api.workstations[':id'].repo.$get({ param: { id } }));
const fetchFiles = async (id: string, path: string) => unwrap(await api.workstations[':id'].files.$get({ param: { id }, query: { path } }));
const fetchFile = async (id: string, path: string) => unwrap(await api.workstations[':id'].file.$get({ param: { id }, query: { path } }));
const fetchTask = async (id: string) => unwrap(await api.tasks[':id'].$get({ param: { id } }));
const fetchTaskRuns = async (id: string) => unwrap(await api.tasks[':id'].runs.$get({ param: { id } }));
const fetchTaskProposals = async (id: string) => unwrap(await api.tasks[':id'].proposals.$get({ param: { id } }));
const fetchTaskTestRuns = async (id: string) => unwrap(await api.tasks[':id'].testruns.$get({ param: { id } }));
const fetchInbox = async (projectId: string, status: string) => unwrap(await api.inbox.$get({ query: { status, projectId } }));
const fetchAllInbox = async (status: string) => unwrap(await api.inbox.$get({ query: { status } }));
const fetchRun = async (id: string) => unwrap(await api.runs[':id'].$get({ param: { id } }));
const fetchEntityVersions = async (id: string) => unwrap(await api.entities[':id'].versions.$get({ param: { id } }));
const fetchArtifact = async (id: string) => unwrap(await api.artifacts[':id'].$get({ param: { id } }));
const fetchTimeline = async (id: string) => unwrap(await api.tasks[':id'].timeline.$get({ param: { id } }));
const fetchPulse = async (id: string) => unwrap(await api.projects[':id'].pulse.$get({ param: { id } }));
const fetchThreadMessages = async (id: string) => unwrap(await api.threads[':id'].messages.$get({ param: { id } }));
const fetchThreadMembers = async (id: string) => unwrap(await api.threads[':id'].members.$get({ param: { id } }));
const fetchLedger = async (id: string) => unwrap(await api.projects[':id'].ledger.$get({ param: { id } }));
const fetchModelConfig = async () => unwrap(await api.settings.models.$get());
const fetchSources = async (id: string) => unwrap(await api.projects[':id'].knowledge.$get({ param: { id }, query: {} }));
const fetchKnowledgeSearch = async (id: string, q: string) => unwrap(await api.projects[':id'].knowledge.search.$get({ param: { id }, query: { q } }));
const fetchChunk = async (id: string) => unwrap(await api.knowledge.chunks[':id'].$get({ param: { id } }));
const fetchPlugins = async () => unwrap(await api.plugins.$get());
const fetchModels = async () => unwrap(await api.models.$get());

export type ProjectSummary = Awaited<ReturnType<typeof fetchProjects>>[number];
export type ProjectDetail = Awaited<ReturnType<typeof fetchProject>>;
export type Overview = Awaited<ReturnType<typeof fetchOverview>>;
export type WsNode = ProjectDetail['workstations'][number];
export type ProjectAgent = ProjectDetail['agents'][number];
export type WorkstationDetail = Awaited<ReturnType<typeof fetchWorkstation>>;
export type Manifest = NonNullable<WorkstationDetail['manifest']>;
export type TaskType = Manifest['tasks'][number];
export type WsAgent = WorkstationDetail['agents'][number];
export type Block = WorkstationDetail['blocks'][number];
export type BoardTask = Awaited<ReturnType<typeof fetchWsTasks>>[number];
export type TaskDetail = Awaited<ReturnType<typeof fetchTask>>;
export type TaskEventRow = TaskDetail['events'][number];
export type Proposal = Awaited<ReturnType<typeof fetchWsProposals>>[number];
export type TestRun = Awaited<ReturnType<typeof fetchWsTestRuns>>[number];
export type EntityRow = Awaited<ReturnType<typeof fetchWsEntities>>['entities'][number];
export type RunRow = Awaited<ReturnType<typeof fetchProjectRuns>>[number];
export type RunDetail = Awaited<ReturnType<typeof fetchRun>>;
export type InboxRow = Awaited<ReturnType<typeof fetchInbox>>[number];
export type TimelineItem = Awaited<ReturnType<typeof fetchTimeline>>[number];
export type PulseAgent = Awaited<ReturnType<typeof fetchPulse>>[number];
export type Ledger = Awaited<ReturnType<typeof fetchLedger>>;
export type LedgerRow = Ledger['byAgent'][number];
export type ModelConfig = Awaited<ReturnType<typeof fetchModelConfig>>;
export type PluginInfo = Awaited<ReturnType<typeof fetchPlugins>>[number];
export type ProjectTask = Awaited<ReturnType<typeof fetchProjectTasks>>[number];

const on = <T,>(id: T | null | undefined) => id !== null && id !== undefined && id !== '';

export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
export const useProject = (id: string, enabled = true) => useQuery({ queryKey: ['project', id], queryFn: () => fetchProject(id), enabled: enabled && on(id) });
export const useOverview = (id: string) => useQuery({ queryKey: ['overview', id], queryFn: () => fetchOverview(id) });
export const useProjectTasks = (id: string, enabled = true) => useQuery({ queryKey: ['project-tasks', id], queryFn: () => fetchProjectTasks(id), enabled });
export const useProjectRuns = (id: string) => useQuery({ queryKey: ['runs', 'project', id], queryFn: () => fetchProjectRuns(id) });
export const useWorkstation = (id: string | null | undefined) => useQuery({ queryKey: ['ws', id], queryFn: () => fetchWorkstation(id!), enabled: on(id) });
export const useWsTasks = (id: string) => useQuery({ queryKey: ['tasks', id], queryFn: () => fetchWsTasks(id) });
export const useWsProposals = (id: string) => useQuery({ queryKey: ['proposals', 'ws', id], queryFn: () => fetchWsProposals(id) });
export const useWsTestRuns = (id: string) => useQuery({ queryKey: ['testruns', 'ws', id], queryFn: () => fetchWsTestRuns(id) });
export const useWsEntities = (id: string) => useQuery({ queryKey: ['entities', id], queryFn: () => fetchWsEntities(id) });
export const useAgentStatus = (id: string | null | undefined) => useQuery({ queryKey: ['agent-status', id], queryFn: () => fetchAgentStatus(id!), enabled: on(id) });
export const useRepoStatus = (id: string) => useQuery({ queryKey: ['repo', id], queryFn: () => fetchRepoStatus(id) });
export const useFiles = (id: string, path: string) => useQuery({ queryKey: ['files', id, path], queryFn: () => fetchFiles(id, path) });
export const useFile = (id: string, path: string | null) => useQuery({ queryKey: ['file', id, path], queryFn: () => fetchFile(id, path!), enabled: on(path) });
export const useTask = (id: string | null | undefined) => useQuery({ queryKey: ['task', id], queryFn: () => fetchTask(id!), enabled: on(id) });
export const useTaskRuns = (id: string) => useQuery({ queryKey: ['runs', 'task', id], queryFn: () => fetchTaskRuns(id) });
export const useTaskProposals = (id: string) => useQuery({ queryKey: ['proposals', 'task', id], queryFn: () => fetchTaskProposals(id) });
export const useTaskTestRuns = (id: string) => useQuery({ queryKey: ['testruns', 'task', id], queryFn: () => fetchTaskTestRuns(id) });
export const useInbox = (projectId: string, status = 'open') =>
  useQuery({ queryKey: ['inbox', projectId, status], queryFn: () => fetchInbox(projectId, status), refetchInterval: 15000 });
// 控制台跨项目汇总；key 仍以 inbox 开头，实时失效规则照常命中
export const useAllInbox = (status = 'open') =>
  useQuery({ queryKey: ['inbox', 'all', status], queryFn: () => fetchAllInbox(status), refetchInterval: 15000 });
export const useRun = (id: string) => useQuery({ queryKey: ['run', id], queryFn: () => fetchRun(id) });
export const useEntityVersions = (id: string | null) => useQuery({ queryKey: ['entity-versions', id], queryFn: () => fetchEntityVersions(id!), enabled: on(id) });
export const useArtifact = (id: string | null) => useQuery({ queryKey: ['artifact', id], queryFn: () => fetchArtifact(id!), enabled: on(id) });
export const useTimeline = (id: string) => useQuery({ queryKey: ['timeline', id], queryFn: () => fetchTimeline(id) });
export const useTeamPulse = (id: string) => useQuery({ queryKey: ['pulse', id], queryFn: () => fetchPulse(id) });
export const useThreadMessages = (id: string) => useQuery({ queryKey: ['thread-messages', id], queryFn: () => fetchThreadMessages(id) });
export const useThreadMembers = (id: string) => useQuery({ queryKey: ['thread-members', id], queryFn: () => fetchThreadMembers(id), staleTime: 60000 });
export const useLedger = (id: string) => useQuery({ queryKey: ['ledger', id], queryFn: () => fetchLedger(id) });
export const useModelConfig = () => useQuery({ queryKey: ['model-config'], queryFn: fetchModelConfig });
export const useKnowledgeSources = (id: string) => useQuery({ queryKey: ['knowledge', id], queryFn: () => fetchSources(id) });
export const useKnowledgeSearch = (id: string, q: string) => useQuery({ queryKey: ['knowledge', id, 'search', q], queryFn: () => fetchKnowledgeSearch(id, q) });
export const useChunk = (id: string | null) => useQuery({ queryKey: ['chunk', id], queryFn: () => fetchChunk(id!), enabled: on(id) });
export const usePlugins = () => useQuery({ queryKey: ['plugins'], queryFn: fetchPlugins });
export const useModels = () => useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60000 });

export interface DispatchTarget { id: string; name: string; taskTypes: TaskType[] }

// 任务只能派发给所在台的子孙，且目标插件要声明任务类型
export function useDispatchTargets(project: ProjectDetail | undefined, wsId: string | undefined): DispatchTarget[] {
  const all = project?.workstations ?? [];
  const ids: string[] = [];
  const queue = wsId ? [wsId] : [];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const w of all) {
      if (w.parentId === cur) {
        ids.push(w.id);
        queue.push(w.id);
      }
    }
  }
  const details = useQueries({ queries: ids.map((id) => ({ queryKey: ['ws', id], queryFn: () => fetchWorkstation(id) })) });
  return details.flatMap((q) => (q.data?.manifest?.tasks.length ? [{ id: q.data.id, name: q.data.name, taskTypes: q.data.manifest.tasks }] : []));
}

export type NameMaps = { ws: Record<string, string>; agent: Record<string, string> };

export function nameMaps(project: ProjectDetail | undefined): NameMaps {
  return {
    ws: Object.fromEntries((project?.workstations ?? []).map((w) => [w.id, w.name])),
    agent: Object.fromEntries((project?.agents ?? []).map((a) => [a.id, a.name])),
  };
}
