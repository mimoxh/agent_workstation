import { expect, test } from '@playwright/test';

test('根台建任务 → 派发到开发台 → 详情页事件日志', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Agent Workstation', { exact: true }).click();
  await expect(page.getByText('工作台树')).toBeVisible();

  // 根台：新建任务（含 module）
  await page.getByTestId('new-task-title').fill('e2e 派发任务');
  await page.getByTestId('new-task-module').fill('apps/web/src/components/board/');
  await page.getByRole('button', { name: '新建任务' }).click();
  const draftCol = page.getByTestId('board-column-草稿');
  await expect(draftCol.getByText('e2e 派发任务')).toBeVisible();

  // 打开派发对话框 → 开发 / dev.issue / feature / p1
  await draftCol.locator('[data-task-title="e2e 派发任务"]').getByRole('button', { name: '派发' }).click();
  await expect(page.getByTestId('dispatch-dialog')).toBeVisible();
  await page.getByTestId('dispatch-dialog').getByRole('button', { name: '派发' }).click();
  await expect(page.locator('[data-task-title="e2e 派发任务"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('已派发 → 开发')).toBeVisible();

  // 开发台：tabs + 成员列表
  await page.getByRole('link', { name: '开发', exact: true }).click();
  for (const t of ['任务看板', '改动审阅', '测试结果', '架构决策', '文件树', '页面预览']) {
    await expect(page.getByRole('button', { name: t })).toBeVisible();
  }
  await expect(page.getByText('架构师')).toBeVisible();
  await expect(page.getByText('前端开发 #2')).toBeVisible();
  await expect(page.getByText('steward')).toBeVisible();

  // 回根台进任务详情看事件日志
  await page.getByRole('link', { name: '根', exact: true }).click();
  await page.getByRole('link', { name: 'e2e 派发任务' }).click();
  await expect(page.getByText('事件日志')).toBeVisible();
  await expect(page.getByText('task_assigned')).toBeVisible();

  // steward mock 已自动接单并触发运行
  await page.waitForTimeout(3000);
  await page.getByRole('link', { name: '开发', exact: true }).click();
  await expect(page.locator('[data-testid=thread-view]')).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: '根', exact: true }).click();
  await page.getByRole('link', { name: 'e2e 派发任务' }).click();
  await expect(page.getByText('运行记录')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('link', { name: /mock:scripted/ }).first()).toBeVisible();
  await page.getByRole('link', { name: /mock:scripted/ }).first().click();
  await expect(page.getByTestId('run-trace')).toBeVisible({ timeout: 10000 });
  // 子任务出现在 stage 看板「实现」列
  await page.getByRole('link', { name: '开发', exact: true }).click();
  await expect(page.locator('[data-testid=board-column-implement], [data-testid^=board-column]').filter({ hasText: '实现' }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('实现 A（mock）')).toBeVisible({ timeout: 15000 });
  // run 页：agent 名称 + tokens 输出 > 0
  await page.getByRole('link', { name: '根', exact: true }).click();
  await page.getByRole('link', { name: 'e2e 派发任务' }).click();
  await page.getByRole('link', { name: /mock:scripted/ }).first().click();
  await expect(page.getByRole('link', { name: '架构师' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/tokens \d+\+[1-9]/)).toBeVisible();
  // 脚本化 mock：开发台出现子任务 + 运行记录
});

test('剧本 A 全链路：父任务完成 + 面板数据', async ({ page }) => {
  const api = 'http://127.0.0.1:8877';
  const proj = await (await fetch(`${api}/api/projects/proj-aw`)).json();
  const dev = proj.workstations[1];
  const root = proj.workstations[0];
  const task = await (await fetch(`${api}/api/workstations/${root.id}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'e2e剧本A', input: { module: 'src/board' } }) })).json();
  await fetch(`${api}/api/tasks/${task.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'e2e剧本A', kind: 'feature', priority: 'p1', module: 'src/board' }, acceptance: [{ kind: 'command', run: 'node check.js' }] }) });
  // 等链跑完（父任务 done 最长 150s）
  let status = '';
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = await (await fetch(`${api}/api/tasks/${task.id}`)).json();
    status = d.task.status;
    if (status === 'done') break;
  }
  expect(status).toBe('done');
  await page.goto(`/projects/proj-aw/ws/${dev.id}`);
  // 改动审阅有 merged
  await page.getByRole('button', { name: '改动审阅' }).click();
  await expect(page.getByText('merged').first()).toBeVisible({ timeout: 10000 });
  // 测试结果有 TestRun
  await page.getByRole('button', { name: '测试结果' }).click();
  await expect(page.getByText('passed').first()).toBeVisible({ timeout: 10000 });
  // 文件树
  await page.getByRole('button', { name: '文件树' }).click();
  await expect(page.locator('[data-testid=file-tree]')).toBeVisible({ timeout: 10000 });
});