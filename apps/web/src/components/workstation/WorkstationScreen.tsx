import { useEffect, useState, type ReactNode } from 'react';
import type { BoardFilter, FlagFilter, StatusFilter } from '@/components/board/filter';
import { TaskBoard } from '@/components/board/TaskBoard';
import { DesignStudio } from '@/components/design/DesignStudio';
import { DocStudio } from '@/components/docs/DocStudio';
import { HealthPanel } from '@/components/docs/HealthPanel';
import { StyleGuidePanel } from '@/components/docs/StyleGuidePanel';
import { AgentsPanel } from '@/components/panels/AgentsPanel';
import { EntityPanel } from '@/components/panels/EntityPanel';
import { ModulesPanel } from '@/components/panels/ModulesPanel';
import { GanttPanel } from '@/components/pm/GanttPanel';
import { MilestonePanel } from '@/components/pm/MilestonePanel';
import { ReportsPanel } from '@/components/pm/ReportsPanel';
import { FilesPanel } from '@/components/panels/FilesPanel';
import { FolderPanel } from '@/components/panels/FolderPanel';
import { KnowledgePanel } from '@/components/panels/KnowledgePanel';
import { PreviewPanel } from '@/components/panels/PreviewPanel';
import { WsProposalsPanel } from '@/components/panels/ProposalReview';
import { SettingsPanel } from '@/components/panels/SettingsPanel';
import { QualityPanel } from '@/components/qa/QualityPanel';
import { WsThread } from '@/components/chat/Thread';
import { PageHeader } from '@/components/layout/Page';
import { AgentTalk } from './AgentTalk';
import { TeamPulse } from '@/components/team/TeamPulse';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/feedback';
import { setDock } from './dock';
import { homeBlock, isDockBlock } from './home';
import { Icon, panelIcon, type IconName } from '@/components/ui/icons';
import { num, parseJson } from '@/lib/format';
import { nameMaps, type Block, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';

export interface WsSearch { panel?: string; q?: string; status?: StatusFilter; assignee?: string; flag?: FlagFilter; design?: string; item?: string; thread?: string }

const STATUSES: StatusFilter[] = ['open', 'attention', 'done'];
const FLAG_IDS: FlagFilter[] = ['overdue', 'waiting'];

export const parseWsSearch = (s: Record<string, unknown>): WsSearch => ({
  ...(typeof s.panel === 'string' ? { panel: s.panel } : {}),
  ...(typeof s.q === 'string' && s.q ? { q: s.q } : {}),
  ...(typeof s.design === 'string' && s.design ? { design: s.design } : {}),
  ...(typeof s.item === 'string' && s.item ? { item: s.item } : {}),
  ...(typeof s.thread === 'string' && s.thread ? { thread: s.thread } : {}),
  ...(typeof s.assignee === 'string' && s.assignee ? { assignee: s.assignee } : {}),
  ...(FLAG_IDS.includes(s.flag as FlagFilter) ? { flag: s.flag as FlagFilter } : {}),
  ...(STATUSES.includes(s.status as StatusFilter) ? { status: s.status as StatusFilter } : {}),
});

// 板块渲染器注册表：panel.type（+ 实体）→ 组件
export function renderPanel(block: Block, ws: WorkstationDetail, project: ProjectDetail, filter: BoardFilter, onFilter: (f: BoardFilter) => void): ReactNode {
  const def = block.entityType ? ws.manifest?.entities[block.entityType] : undefined;
  const editable = ws.manifest?.panels.find((p) => p.id === block.panelId)?.editableBy.includes('human') ?? false;
  switch (block.panelType) {
    case 'board': {
      const field = parseJson<{ field?: string }>(block.configJson, {}).field;
      return <TaskBoard ws={ws} project={project} groupBy={field === 'stage' ? 'stage' : 'status'} filter={filter} onFilter={onFilter} />;
    }
    case 'diff':
      return <WsProposalsPanel wsId={ws.id} projectId={project.id} />;
    case 'tree':
      return block.entityType === 'system:folder' ? <FolderPanel project={project} /> : <FilesPanel wsId={ws.id} />;
    case 'table':
      if (block.entityType === 'StatusReport' && def) return <ReportsPanel ws={ws} project={project} def={def} editable={editable} />;
      if (block.entityType === 'Module' && def) return <ModulesPanel ws={ws} def={def} editable={editable} />;
      return def ? <EntityPanel wsId={ws.id} entityType={block.entityType!} def={def} editable={editable} /> : null;
    case 'timeline':
      if (block.entityType === 'Milestone' && def) return <MilestonePanel ws={ws} project={project} def={def} editable={editable} />;
      return def ? <EntityPanel wsId={ws.id} entityType={block.entityType!} def={def} editable={editable} sortByDate /> : null;
    case 'gantt':
      return <GanttPanel project={project} />;
    case 'knowledge':
      return <KnowledgePanel projectId={project.id} />;
    case 'tokens':
      return <Empty title="这个板块已从插件中移除" />;
    case 'doc':
      return parseJson<{ view?: string }>(block.configJson, {}).view === 'style' ? <StyleGuidePanel ws={ws} /> : <Empty title="文档台请在工作台主视图打开" />;
    case 'quality':
      return <QualityPanel block={block} ws={ws} project={project} />;
    case 'preview':
      return <PreviewPanel wsId={ws.id} config={{ ...parseJson<{ urlField?: string; baselineField?: string }>(block.configJson, {}), ...(block.entityType ? { entity: block.entityType } : {}) }} />;
    default:
      return <Empty title={`${block.name}板块未装载`}>{ws.manifest?.name} 还没有这个板块的渲染器。</Empty>;
  }
}

const MEMBERS_KEY = 'aw.rail.right';
const readMembers = () => {
  try {
    return localStorage.getItem(MEMBERS_KEY) !== '0';
  } catch {
    return true;
  }
};

function PanelFrame({ icon, title, desc, actions, children }: { icon: IconName; title: string; desc?: string | null | undefined; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pb-2 md:px-8">
        <PageHeader compact icon={icon} title={title} {...(desc ? { desc } : {})} actions={actions} />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

// 工作台大群：根台就是和项目经理的对话；右侧是成员在做什么
function WsChat({ ws, project }: { ws: WorkstationDetail; project: ProjectDetail }) {
  const [members, setMembers] = useState(readMembers);
  const root = ws.parentId === null;
  const names = nameMaps(project).agent;
  const children = project.workstations.filter((w) => w.parentId === ws.id).map((w) => w.id);
  const toggle = () => {
    const next = !members;
    setMembers(next);
    try {
      localStorage.setItem(MEMBERS_KEY, next ? '1' : '0');
    } catch {
      /* 存储不可用时只影响本次会话 */
    }
  };
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 px-5 md:px-10 lg:px-14">
          <div className="mx-auto max-w-[54rem]">
            <PageHeader
              compact
              icon="hash"
              title={`${ws.name}大群`}
              desc={root ? '和项目经理说目标，它起草任务，确认后派发' : (ws.manifest?.description ?? '工作台级讨论，任务细节进各自的任务页')}
              actions={<Button variant="quiet" aria-pressed={members} onClick={toggle} className="aria-pressed:bg-paper-3 aria-pressed:text-ink" data-testid="rail-toggle"><Icon name="people" className="size-3.5" />成员</Button>}
            />
          </div>
        </div>
        <WsThread wsId={ws.id} projectId={project.id} names={names} root={root} wide />
      </div>
      {members && (
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-rule max-lg:hidden" aria-label="成员">
          <TeamPulse projectId={project.id} names={names} only={(a) => a.workstationId === ws.id || (root && a.isSteward === 1 && children.includes(a.workstationId))} />
        </aside>
      )}
    </div>
  );
}

// 左侧栏决定看什么：不带 panel 是大群（声明了 home 的板块优先），带 panel 是对应板块
export function WorkstationScreen({ ws, project, search, onSearch }: { ws: WorkstationDetail; project: ProjectDetail; search: WsSearch; onSearch: (s: WsSearch, replace?: boolean) => void }) {
  const picked = search.panel ? ws.blocks.find((b) => b.panelId === search.panel) : undefined;
  const docked = picked && isDockBlock(picked) ? picked.panelId : null;
  // 右侧栏板块的旧链接（?panel=changes 等）：打开右侧栏，主区回到默认入口
  useEffect(() => {
    if (!docked) return;
    setDock(docked);
    // onSearch 每次渲染都是新函数，只在要转去右侧栏的板块变化时跑一次
    onSearch({}, true);
  }, [docked]);
  const block = docked ? homeBlock(ws.blocks) : search.panel ? picked : homeBlock(ws.blocks);
  const onFilter = (f: BoardFilter) =>
    onSearch(
      {
        ...(search.panel ? { panel: search.panel } : {}),
        ...(f.q ? { q: f.q } : {}),
        ...(f.status ? { status: f.status as StatusFilter } : {}),
        ...(f.assignee ? { assignee: f.assignee } : {}),
        ...(f.flag ? { flag: f.flag } : {}),
      },
      true,
    );
  const budget = ws.manifest?.defaults?.taskBudget;
  const budgetNote = budget?.tokens ? `单次运行上限 ${num(budget.tokens)} tok${budget.minutes ? ` / ${budget.minutes} min` : ''}` : null;

  let content: ReactNode;
  if (search.panel === '_agents') content = <PanelFrame icon="people" title="成员" desc={`${ws.name}的 Agent 编制：模型、权限、预算`}><AgentsPanel ws={ws} /></PanelFrame>;
  else if (search.panel === '_talk') content = <PanelFrame icon="chat" title="Agent" desc="和成员私聊，或拉几位一起开群"><AgentTalk ws={ws} project={project} selected={search.thread} onSelect={(id) => onSearch({ panel: '_talk', ...(id ? { thread: id } : {}) })} /></PanelFrame>;
  else if (search.panel === '_settings') content = <PanelFrame icon="gear" title="工作台设置" desc={budgetNote}><SettingsPanel key={ws.id} ws={ws} project={project} /></PanelFrame>;
  else if (block?.panelType === 'canvas') content = <DesignStudio ws={ws} project={project} openId={search.design} onOpen={(id) => onSearch({ ...(search.panel ? { panel: search.panel } : {}), ...(id ? { design: id } : {}) })} />;
  else if (block?.panelType === 'doc' && parseJson<{ view?: string }>(block.configJson, {}).view === 'health') {
    content = <HealthPanel ws={ws} project={project} onOpen={(id) => onSearch({ panel: 'studio', item: id })} />;
  } else if (block?.panelType === 'doc' && parseJson<{ view?: string }>(block.configJson, {}).view !== 'style') {
    content = <DocStudio ws={ws} project={project} openId={search.item} onOpen={(id) => onSearch({ ...(search.panel ? { panel: search.panel } : {}), ...(id ? { item: id } : {}) })} />;
  } else if (block) {
    content = (
      <PanelFrame icon={panelIcon(block.panelType, block.entityType, block.panelId)} title={block.name ?? block.panelId ?? ''} desc={ws.name}>
        {renderPanel(block, ws, project, { q: search.q, status: search.status, assignee: search.assignee, flag: search.flag }, onFilter)}
      </PanelFrame>
    );
  } else content = <WsChat ws={ws} project={project} />;

  return <div className="flex h-full min-h-0 flex-col" data-testid="workstation">{content}</div>;
}
