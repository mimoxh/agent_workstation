import { describe, expect, it } from 'vitest';
import { filterTasks } from '../components/board/filter';
import { fromChecks, parseChecks, qaSuiteChecks, toChecks } from '../components/board/schemaForm';
import { mentionQuery } from '../components/chat/mention';
import { foldByDecision } from '../components/timeline/fold';
import { layoutGantt } from '../components/pm/gantt';
import { parseDiff } from './diff';
import { duration, parseJson, seconds, tokens, when } from './format';
import { keysFor } from './live';
import { applyDraft, commentsPrompt, compareDesigns, downloadName, exportDoc, parseFrameEvent, previewDoc, tweakVars } from '../components/design/model';

describe('parseDiff', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@ function x() {',
    ' keep',
    '-old',
    '+new',
    '+added',
    ' tail',
    'diff --git a/b c.txt b/b c.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b c.txt',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');

  it('按文件切分并统计增删', () => {
    const files = parseDiff(patch);
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([['src/a.ts', 2, 1], ['b c.txt', 1, 0]]);
  });

  it('文件头的 --- / +++ 不算增删行', () => {
    expect(parseDiff(patch)[0]!.lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['old']);
  });

  it('行号跟随 hunk 递增，新增行没有旧行号', () => {
    const lines = parseDiff(patch)[0]!.lines.slice(1);
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]);
  });

  it('空补丁与 CRLF', () => {
    expect(parseDiff('')).toEqual([]);
    const f = parseDiff('diff --git a/x b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0]!;
    expect(f.lines.at(-1)!.text).toBe('b');
  });
});

describe('filterTasks', () => {
  const names = { ws: { w1: '开发' }, agent: { a1: '前端开发' } };
  const t = (title: string, status: string, extra: Partial<{ inputJson: string; assigneeId: string; dueAt: string; dependsOn: string[] }> = {}) => ({ title, status, inputJson: null, assigneeId: null, dueAt: null, dependsOn: [], ...extra });
  const tasks = [
    t('看板筛选', 'in_progress', { inputJson: '{"module":"apps/web"}', assigneeId: 'a1' }),
    t('修复登录', 'blocked'),
    t('已合并', 'done'),
    t('废弃', 'cancelled'),
  ];
  const titles = (f: Parameters<typeof filterTasks>[1]) => filterTasks(tasks, f, names).map((x) => x.title);

  it('空筛选返回全部', () => expect(titles({})).toHaveLength(4));
  it('按标题、模块、指派搜索', () => {
    expect(titles({ q: '登录' })).toEqual(['修复登录']);
    expect(titles({ q: 'APPS/web' })).toEqual(['看板筛选']);
    expect(titles({ q: '前端' })).toEqual(['看板筛选']);
  });
  it('状态分组', () => {
    expect(titles({ status: 'open' })).toEqual(['看板筛选', '修复登录']);
    expect(titles({ status: 'attention' })).toEqual(['修复登录']);
    expect(titles({ status: 'done' })).toEqual(['已合并', '废弃']);
  });
  it('搜索与状态同时生效', () => expect(titles({ q: '看板', status: 'done' })).toEqual([]));
  it('按负责人筛：指定 Agent 与未指派', () => {
    expect(titles({ assignee: 'a1' })).toEqual(['看板筛选']);
    expect(titles({ assignee: 'none' })).toEqual(['修复登录', '已合并', '废弃']);
  });
  it('标记筛：逾期与等待前置', () => {
    const ts = [
      t('超期在做', 'in_progress', { dueAt: '2020-01-01' }),
      t('超期已结', 'done', { dueAt: '2020-01-01' }),
      t('等前置', 'draft', { dependsOn: ['d1', 'd2'] }),
      t('等已好', 'draft', { dependsOn: ['d2'] }),
    ];
    const deps = new Map([
      ['d1', 'in_progress'],
      ['d2', 'done'],
    ]);
    const pick = (f: Parameters<typeof filterTasks>[1]) => filterTasks(ts, f, names, deps).map((x) => x.title);
    expect(pick({ flag: 'overdue' })).toEqual(['超期在做']);
    expect(pick({ flag: 'waiting' })).toEqual(['等前置']);
    expect(pick({ flag: 'waiting', status: 'done' })).toEqual([]);
  });
});

describe('验收命令', () => {
  it('多行文本与 check 互转，忽略空行', () => {
    const checks = toChecks('pnpm build\n\n  pnpm test  \n');
    expect(checks.map((c) => c.run)).toEqual(['pnpm build', 'pnpm test']);
    expect(fromChecks(JSON.stringify(checks))).toBe('pnpm build\npnpm test');
  });
  it('坏 JSON 不抛错', () => expect(fromChecks('{')).toBe(''));

  it('非命令检查不进文本框，保存时原样带过去', () => {
    const json = JSON.stringify([
      { kind: 'command', run: 'pnpm test', expect: { exitCode: 0 } },
      { kind: 'qa_suite', suite: 's1' },
      { kind: 'visual' },
      { kind: 'manual', run: '手动跑一遍' },
    ]);
    // 文本框只编辑命令类；manual 带 run 也不该出现在编辑文本里
    expect(fromChecks(json)).toBe('pnpm test');
    const extras = parseChecks(json).filter((c) => c.kind !== 'command');
    const saved = toChecks('pnpm build', extras);
    expect(saved).toEqual([
      { kind: 'command', run: 'pnpm build', expect: { exitCode: 0 } },
      { kind: 'qa_suite', suite: 's1' },
      { kind: 'visual' },
      { kind: 'manual', run: '手动跑一遍' },
    ]);
  });

  it('qa_suite 勾选集合从 checks 里往返还原', () => {
    const json = JSON.stringify([{ kind: 'qa_suite', suite: 's1' }, { kind: 'command', run: 'x' }, { kind: 'qa_suite' }, { kind: 'qa_suite', suite: 's2' }]);
    expect(qaSuiteChecks(json).map((c) => c.suite)).toEqual(['s1', 's2']);
    // 勾掉 s1 留 s2，另加 s3
    const kept = qaSuiteChecks(json).filter((c) => c.suite === 's2');
    const saved = toChecks('', [...parseChecks(json).filter((c) => c.kind !== 'command' && c.kind !== 'qa_suite'), ...kept, { kind: 'qa_suite', suite: 's3' }]);
    expect(qaSuiteChecks(JSON.stringify(saved)).map((c) => c.suite)).toEqual(['s2', 's3']);
    expect(saved.map((c) => c.kind)).toEqual(['qa_suite', 'qa_suite']);
  });

  it('qa_ 事件同时刷新质量、任务回声、项目状态和实体列表', () => {
    for (const action of ['qa_run_finished', 'qa_plan_signed']) {
      const keys = keysFor(action);
      for (const k of ['qa', 'task-quality', 'project-status', 'entities']) expect(keys).toContain(k);
    }
  });
});

describe('mentionQuery', () => {
  it('只在 @ 紧贴光标的词上触发', () => {
    expect(mentionQuery('hi @架', 5)).toBe('架');
    expect(mentionQuery('@', 1)).toBe('');
    expect(mentionQuery('hi @架构师 好', 9)).toBeNull();
    expect(mentionQuery('a@b.com', 7)).toBeNull();
  });
});

describe('foldByDecision', () => {
  const rows = (kinds: string[]) => foldByDecision(kinds, (k) => k === 'chat', (k) => k === 'decision');

  it('结论收起它之前的聊天，其他条目保留原位', () => {
    expect(rows(['chat', 'status', 'chat', 'decision'])).toEqual([
      { item: 'status', folded: [] },
      { item: 'decision', folded: ['chat', 'chat'] },
    ]);
  });
  it('结论之后的聊天不被折叠', () => {
    expect(rows(['chat', 'decision', 'chat'])).toEqual([
      { item: 'decision', folded: ['chat'] },
      { item: 'chat', folded: [] },
    ]);
  });
  it('没有结论时全部展开并保持时间顺序', () => {
    expect(rows(['chat', 'status', 'chat'])).toEqual([
      { item: 'chat', folded: [] },
      { item: 'status', folded: [] },
      { item: 'chat', folded: [] },
    ]);
  });
});

describe('format', () => {
  it('tokens 分档', () => {
    expect(tokens(null)).toBe('0');
    expect(tokens(9999)).toBe('9,999');
    expect(tokens(46310)).toBe('46.3k');
    expect(tokens(1_500_000)).toBe('1.5M');
  });
  it('seconds 跨分钟', () => {
    expect(seconds(4.56)).toBe('4.6s');
    expect(seconds(65)).toBe('1:05');
  });
  it('duration 用结束时间，缺开始时间给占位', () => {
    expect(duration('2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z')).toBe('2.0s');
    expect(duration(null)).toBe('—');
  });
  it('when 当天只显示时分', () => {
    const now = new Date(2026, 10, 6, 12);
    expect(when(new Date(2026, 10, 6, 9, 5).toISOString(), now)).toBe('09:05');
    expect(when(new Date(2026, 10, 5, 9, 5).toISOString(), now)).toBe('11-05 09:05');
  });
  it('parseJson 兜底', () => {
    expect(parseJson('{', 1)).toBe(1);
    expect(parseJson(null, 2)).toBe(2);
  });
});

describe('甘特图布局', () => {
  const t = (id: string, startAt: string | null, dueAt: string | null, status = 'in_progress', createdAt = '2026-01-01T00:00:00Z') => ({ id, title: id, status, workstationId: 'w1', startAt, dueAt, createdAt });

  it('范围包住任务与里程碑并留边，条按日定位', () => {
    const l = layoutGantt({
      tasks: [t('a', '2026-01-10', '2026-01-15'), t('b', null, '2026-01-12', 'draft', '2026-01-05T00:00:00Z')],
      milestones: [{ id: 'm1', name: 'v1', due: '2026-01-20' }],
      today: '2026-01-11',
      pad: 2,
    });
    // 最早 01-05（b 的创建日），最晚 01-20（里程碑）→ 各留 2 天 = 01-03 ~ 01-22
    expect(l.days).toBe(20);
    const a = l.bars.find((b) => b.task.id === 'a')!;
    expect([a.left, a.width]).toEqual([7, 6]);
    const b = l.bars.find((x) => x.task.id === 'b')!;
    expect([b.left, b.width]).toEqual([2, 8]);
    expect(l.milestones[0]!.pos).toBe(17);
    expect(l.today).toBe(8);
  });

  it('没有截止的任务不进图，逾期任务标记 overdue，开始晚于截止时退化为截止日', () => {
    const l = layoutGantt({
      tasks: [t('x', '2026-02-10', '2026-02-01'), t('y', null, null), t('z', null, '2026-01-01', 'in_progress')],
      milestones: [],
      today: '2026-02-05',
      pad: 0,
    });
    expect(l.bars).toHaveLength(2);
    expect(l.bars.find((b) => b.task.id === 'x')!.width).toBe(1);
    expect(l.bars.find((b) => b.task.id === 'z')!.overdue).toBe(true);
    const l2 = layoutGantt({ tasks: [t('z', null, '2026-01-01', 'done')], milestones: [], today: '2026-02-05', pad: 0 });
    expect(l2.bars[0]!.overdue).toBe(false);
  });
});

describe('实时失效映射', () => {
  it('任务变更刷新看板、详情和收件箱', () => {
    expect(keysFor('task_status_changed')).toEqual(expect.arrayContaining(['tasks', 'task', 'inbox']));
  });
  it('消息刷新时间线和会话', () => expect(keysFor('message_created')).toEqual(['timeline', 'thread-messages']));
  it('运行步骤只刷新脉搏和时间线', () => expect(keysFor('run_step')).toEqual(['pulse', 'timeline']));
  it('未知动作不触发刷新', () => expect(keysFor('unknown_action')).toEqual([]));
});

describe('设计稿', () => {
  it('只接受形状正确的沙箱消息', () => {
    expect(parseFrameEvent({ aw: 'design-frame', type: 'pin', n: 2 })).toEqual({ type: 'pin', n: 2 });
    expect(parseFrameEvent({ aw: 'design-frame', type: 'pick', selector: 'body', anchor: 'a'.repeat(200), tag: 'h1' })).toMatchObject({ type: 'pick', anchor: 'a'.repeat(80) });
    expect(parseFrameEvent({ aw: 'design-frame', type: 'edit', selector: 1, text: 'x' })).toBeNull();
    expect(parseFrameEvent({ aw: 'other', type: 'pin', n: 1 })).toBeNull();
    expect(parseFrameEvent('x')).toBeNull();
  });

  it('发给设计师的评论带上 id、元素和内容', () => {
    const c = { id: 'c1', rowVersion: 1, authorType: 'human', authorId: 'local', createdAt: '', design: 'd1', selector: 'body > h1', anchor: '标题', body: '放大' };
    const text = commentsPrompt('d1', [c, { ...c, id: 'c2', selector: '', anchor: '', body: '整体太挤' }]);
    expect(text).toContain('design: d1');
    expect(text).toContain('1. comment id: c1 · 元素 `body > h1`（「标题」）：放大');
    expect(text).toContain('2. comment id: c2 · 整页：整体太挤');
  });

  it('旋钮变量带单位，草稿优先', () => {
    const t = { id: 'r', label: 'r', cssVar: '--r', type: 'range' as const, value: '8', unit: 'px' };
    expect(tweakVars([t], {})).toEqual({ '--r': '8px' });
    expect(tweakVars([t], { r: '12' })).toEqual({ '--r': '12px' });
    expect(applyDraft([t], { r: '12' })[0]!.value).toBe('12');
  });

  it('预览文档带沙箱 CSP 和检查脚本，导出文档不带', () => {
    expect(previewDoc('<p>x</p>', [], [])).toContain('Content-Security-Policy');
    expect(previewDoc('<p>x</p>', [], [])).toContain('aw-design-overlay');
    expect(exportDoc('<p>x</p>', [], [])).not.toContain('aw-design-overlay');
    expect(exportDoc('<p>x</p>', [], [])).not.toContain('Content-Security-Policy');
  });

  it('下载文件名去掉非法字符', () => {
    expect(downloadName('落地页 / 方向A', 3)).toBe('落地页-方向A-v3.html');
  });

  it('对比候选：当前稿在前，同组方向随后，别组的稿不进来', () => {
    const d = (id: string, group?: string) => ({ id, data: { group } });
    const list = [d('a', '落地页'), d('b', '落地页'), d('c'), d('e', '别的')];
    expect(compareDesigns(list, 'a').map((x) => x.id)).toEqual(['a', 'b']);
    expect(compareDesigns(list, 'c').map((x) => x.id)).toEqual(['c']);
    expect(compareDesigns(list, 'nope')).toEqual([]);
  });
});
