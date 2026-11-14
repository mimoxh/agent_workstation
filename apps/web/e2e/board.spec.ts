import { expect, test, type Page } from '@playwright/test';

const api = 'http://127.0.0.1:8877';
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const workstations = async () => {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; name: string }[] };
  return { root: proj.workstations.find((w) => w.name === '根')!, dev: proj.workstations.find((w) => w.name === '开发')! };
};

const openWs = (page: Page, name: string) => page.getByTestId(`ws-link-${name}`).click();
// 板块入口在工作台左侧栏；工作台默认打开大群
const tab = (page: Page, name: string) => page.getByTestId(`side-panel-${name}`);

test('根台建任务 → 派发到开发台 → 协作室与运行轨迹', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('command-center')).toBeVisible();
  await page.getByTestId('project-card').filter({ hasText: 'Agent Workstation' }).click();
  await expect(page.getByTestId('workstation')).toBeVisible();

  await tab(page, '任务看板').click();
  await page.getByTestId('new-task').click();
  await page.getByTestId('new-task-title').fill('e2e 派发任务');
  await page.getByTestId('new-task-module').fill('src/board');
  await page.getByRole('button', { name: '创建任务' }).click();
  const draftCol = page.getByTestId('board-column-草稿');
  await expect(draftCol.getByText('e2e 派发任务')).toBeVisible();

  await draftCol.locator('[data-task-title="e2e 派发任务"]').getByRole('button', { name: '派发' }).click();
  await expect(page.getByTestId('dispatch-dialog')).toBeVisible();
  await page.getByTestId('dispatch-dialog').getByRole('button', { name: '派发' }).click();
  await expect(page.getByText('已派发 → 开发').first()).toBeVisible({ timeout: 15000 });

  // 开发台：manifest 板块 + 平台板块 + 成员
  await openWs(page, '开发');
  for (const t of ['任务看板', '测试运行', '质量总览', '缺陷', '架构决策', '成员', '设置']) {
    await expect(tab(page, t)).toBeVisible();
  }
  // 改动审阅、文件树、页面预览在右侧栏
  for (const t of ['改动审阅', '文件树', '页面预览']) {
    await expect(tab(page, t)).toHaveCount(0);
    await expect(page.getByTestId(`dock-tab-${t}`)).toBeVisible();
  }
  await expect(page.getByTestId('member-row').filter({ hasText: '架构师' })).toContainText('steward');
  await expect(page.getByTestId('member-row').filter({ hasText: '前端开发 #2' })).toBeVisible();
  await tab(page, '任务看板').click();

  // 派入的任务接单后按真实 stage 落列，子任务也在看板上
  await expect(page.locator('[data-task-title="e2e 派发任务"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('实现 A（mock）').first()).toBeVisible({ timeout: 30000 });

  // 任务协作室：阶段可见 + 交接 + 子任务泳道 + 运行轨迹
  await page.getByRole('link', { name: 'e2e 派发任务' }).first().click();
  await expect(page.getByTestId('task-header')).toBeVisible();
  await expect(page.getByTestId('stage-rail')).toContainText('实现');
  await expect(page.getByTestId('handoff-card').first()).toBeVisible();
  await expect(page.getByTestId('subtask-lanes')).toContainText('实现 A（mock）');
  await page.getByTestId('task-view-runs').click();
  await page.getByTestId('run-row').filter({ hasText: '架构师' }).first().getByRole('link').first().click();
  await expect(page.getByTestId('run-trace')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('trace-step').first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('run-page').getByRole('heading', { name: '架构师' })).toBeVisible();
  await expect(page.getByTestId('run-tokens')).toHaveText(/tokens \d[\d,]*\+[1-9]/);
});

test('和项目经理说需求 → 起草 → 派发；团队讨论收束成结论', async ({ page }) => {
  const { dev } = await workstations();
  await page.goto('/projects/proj-aw');
  await page.getByTestId('thread-input').fill('给看板加状态筛选');
  await page.getByTestId('thread-send').click();
  await expect(page.getByTestId('draft-link').first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('draft-link').first().click();
  await expect(page.getByTestId('task-header')).toContainText('给看板加状态筛选');
  await expect(page.getByTestId('task-actions').getByRole('button', { name: '派发' })).toBeVisible();

  await page.goto(`/projects/proj-aw/ws/${dev.id}`);
  await page.getByTestId('thread-input').fill('筛选状态放 URL 还是本地？');
  await page.getByTestId('thread-send').click();
  const decision = page.getByTestId('decision-card').first();
  await expect(decision).toBeVisible({ timeout: 20000 });
  await decision.getByTestId('decision-toggle').click();
  await expect(decision.getByTestId('thread-message').first()).toBeVisible();
  await decision.getByTestId('decision-to-adr').click();
  await expect(decision.getByTestId('decision-to-adr')).toHaveText('已提交 ADR 提案');

  // 提案进收件箱，两次点击内可达
  await page.getByTestId('inbox-button').click();
  await page.getByRole('link', { name: '打开收件箱' }).click();
  await expect(page.locator('[data-kind="proposal_review"]').first()).toBeVisible();
});

test('任务里人可以点名 Agent，Agent 能继续点名别人', async ({ page }) => {
  const { dev } = await workstations();
  const agents = (await (await fetch(`${api}/api/workstations/${dev.id}`)).json()) as { agents: { id: string; name: string }[] };
  const fe = agents.agents.find((a) => a.name === '前端开发')!;
  const t = (await (await fetch(`${api}/api/workstations/${dev.id}/tasks`, json({ title: 'e2e点名', input: { kind: 'feature', priority: 'p1', module: 'src/board' } }))).json()) as { id: string };
  await page.goto(`/projects/proj-aw/tasks/${t.id}`);
  await page.getByTestId('thread-input').fill(`@${fe.name} 转问架构师`);
  await page.getByTestId('thread-send').click();
  await expect(page.getByTestId('timeline').getByTestId('thread-message').filter({ hasText: '@架构师' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('timeline').getByTestId('thread-message').filter({ hasText: '收到（mock）' })).toBeVisible({ timeout: 15000 });
});

test('剧本 A 全链路：父任务完成 + 面板数据', async ({ page }) => {
  const { root, dev } = await workstations();
  const task = (await (await fetch(`${api}/api/workstations/${root.id}/tasks`, json({ title: 'e2e剧本A', input: { module: 'src/board' } }))).json()) as { id: string };
  await fetch(`${api}/api/tasks/${task.id}/dispatch`, json({ targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'e2e剧本A', kind: 'feature', priority: 'p1', module: 'src/board' }, acceptance: [{ kind: 'command', run: 'node check.js' }] }));
  let detail = { task: { status: '' }, children: [] as { id: string; title: string; status: string; stage: string; blockedReason: string | null }[] };
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    detail = (await (await fetch(`${api}/api/tasks/${task.id}`)).json()) as typeof detail;
    if (detail.task.status === 'done') break;
  }
  const inbox = await (await fetch(`${api}/api/inbox`)).json();
  expect(detail.task.status, JSON.stringify({ children: detail.children.map((c) => [c.title, c.status, c.stage, c.blockedReason]), inbox })).toBe('done');

  await page.goto(`/projects/proj-aw/ws/${dev.id}`);
  await page.getByTestId('dock-tab-改动审阅').click();
  await page.getByTestId('proposal-list').getByText('已合并').first().click({ timeout: 10000 });
  await expect(page.getByTestId('diff-view')).toBeVisible();

  // 文件树能进目录、能打开文件（修复前进目录后停在原地）
  await page.getByTestId('dock-tab-文件树').click();
  await page.getByTestId('file-entry').filter({ hasText: 'src/' }).click();
  await page.getByTestId('file-entry').filter({ hasText: 'board/' }).click();
  await page.getByTestId('file-entry').filter({ hasText: 'index.txt' }).click();
  await expect(page.getByTestId('file-view')).toContainText('board');

  // 完成的任务：验收断言全绿
  await page.goto(`/projects/proj-aw/tasks/${task.id}`);
  await expect(page.getByTestId('task-status')).toHaveText('完成');
  await expect(page.getByTestId('acceptance-checks')).toContainText('通过');

  // 验收命令的原始输出留在开发任务页的「测试」视图
  const child = detail.children.find((c) => c.title === 'e2e剧本A')!;
  await page.goto(`/projects/proj-aw/tasks/${child.id}`);
  await page.getByTestId('task-view-tests').click();
  await expect(page.getByTestId('testrun-table').getByText('通过').first()).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: '输出' }).first().click();
  await expect(page.getByTestId('testrun-table').locator('pre')).toBeVisible();

  await page.goto('/projects/proj-aw/runs');
  await expect(page.getByTestId('run-row').first()).toBeVisible();
});

test('架构决策与里程碑：人工维护实体并留版本', async ({ page }) => {
  const { root, dev } = await workstations();
  await page.goto(`/projects/proj-aw/ws/${dev.id}`);
  await tab(page, '架构决策').click();
  await expect(page.getByTestId('entity-panel-ADR')).toBeVisible();
  await expect(page.getByTestId('testrun-table')).toHaveCount(0);
  await page.getByRole('button', { name: '新建架构决策' }).first().click();
  await page.getByTestId('entity-title').fill('状态过滤走 URL 参数');
  await page.getByTestId('entity-dialog').getByRole('button', { name: '保存' }).click();
  const row = page.getByRole('button', { name: '状态过滤走 URL 参数' });
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByTestId('entity-title').fill('状态过滤走 URL 参数（修订）');
  await page.getByTestId('entity-dialog').getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('entity-panel-ADR').getByText('v2').first()).toBeVisible();

  await page.goto(`/projects/proj-aw/ws/${root.id}`);
  await expect(page).toHaveURL(/\/projects\/proj-aw$/);
  await tab(page, '里程碑').click();
  await expect(page.getByTestId('milestone-panel')).toBeVisible();
});

test('新建项目、挂载工作台、看板筛选写进 URL', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('e2e 新项目');
  await page.getByTestId('project-template').selectOption('blank');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByTestId('workstation')).toBeVisible();
  await expect(page.getByTestId('ws-link-根')).toBeVisible();

  await page.getByTestId('mount-button').click();
  await page.getByTestId('mount-name').fill('开发二');
  await page.getByRole('button', { name: '挂载', exact: true }).click();
  await expect(page.getByTestId('workstation')).toBeVisible();
  await expect(page.getByTestId('mount-dialog')).toHaveCount(0);
  await expect(page.getByTestId('ws-link-开发二')).toBeVisible();

  await openWs(page, '根');
  await expect(page.getByTestId('workstation')).toBeVisible();
  await tab(page, '任务看板').click();
  for (const title of ['筛选甲', '筛选乙']) {
    await page.getByTestId('new-task').click();
    await page.getByTestId('new-task-title').fill(title);
    await page.getByRole('button', { name: '创建任务' }).click();
    await expect(page.locator(`[data-task-title="${title}"]`)).toBeVisible();
  }
  await page.getByTestId('board-search').fill('甲');
  await expect(page).toHaveURL(/q=/);
  await expect(page.locator('[data-task-title="筛选乙"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('board-search')).toHaveValue('甲');
  await expect(page.locator('[data-task-title="筛选甲"]')).toBeVisible();
  await expect(page.locator('[data-task-title="筛选乙"]')).toHaveCount(0);
  await page.getByTestId('board-search').fill('');
  await page.getByTestId('board-filter-done').click();
  await expect(page.locator('[data-task-title="筛选甲"]')).toHaveCount(0);
});

test('知识库、账本与全局页', async ({ page }) => {
  const { dev } = await workstations();
  await page.goto(`/projects/proj-aw/ws/${dev.id}?panel=knowledge`);
  await page.getByTestId('knowledge-note').click();
  await page.getByTestId('note-name').fill('看板规范');
  await page.getByTestId('note-content').fill('# 筛选\n筛选状态必须放进 URL 参数');
  await page.getByTestId('note-dialog').getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('knowledge-sources')).toContainText('看板规范');
  await page.getByTestId('knowledge-search').fill('URL 参数');
  await expect(page.getByTestId('knowledge-results')).toContainText('筛选');

  await page.goto('/projects/proj-aw/runs');
  await expect(page.getByTestId('ledger-总 tokens')).toBeVisible();
  await expect(page.getByLabel('按成员')).toContainText('架构师');

  // 项目设置：预算写入后顶栏显示余量
  await page.goto('/projects/proj-aw/settings');
  await page.getByTestId('project-budget').fill('100000000');
  await page.getByTestId('project-settings-save').click();
  await expect(page.getByTestId('budget-left')).toBeVisible();

  await page.getByTestId('settings-link').click();
  await expect(page.getByTestId('settings-page')).toContainText('mock:scripted');
  await page.getByRole('link', { name: 'Agent 模板' }).click();
  await expect(page.getByTestId('template-card').filter({ hasText: '架构师' })).toContainText('steward');
  await page.getByRole('link', { name: '插件' }).click();
  await expect(page.getByTestId('plugin-card').filter({ hasText: '全栈开发工作台' })).toContainText('已启用');
});

test('命令面板跳转，错误有提示', async ({ page }) => {
  const { root } = await workstations();
  await page.goto('/projects/proj-aw');
  await expect(page.getByTestId('live-status')).toContainText('实时');
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-input').fill('账本');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('runs-page')).toBeVisible();

  // 另一个客户端改了状态后再点：409 要给用户看到，不能静默失败
  const t = (await (await fetch(`${api}/api/workstations/${root.id}/tasks`, json({ title: 'e2e冲突' }))).json()) as { id: string };
  await page.goto(`/projects/proj-aw/tasks/${t.id}`);
  await page.getByTestId('task-actions').getByRole('button', { name: '取消任务' }).waitFor();
  await page.route('**/transition', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '任务状态已变化，请刷新后重试' }) }));
  await page.getByTestId('task-actions').getByRole('button', { name: '取消任务' }).click();
  await expect(page.getByTestId('toast')).toContainText('任务状态已变化');
});
