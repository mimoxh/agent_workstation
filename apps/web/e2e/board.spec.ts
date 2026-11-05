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
  await expect(page.getByTestId('board-column-已派发').getByText('e2e 派发任务')).toBeVisible();
  await expect(page.getByText('已派发 → 开发')).toBeVisible();

  // 开发台：tabs + 成员列表
  await page.getByRole('link', { name: '开发' }).click();
  for (const t of ['任务看板', '改动审阅', '测试结果', '架构决策', '文件树', '页面预览']) {
    await expect(page.getByRole('button', { name: t })).toBeVisible();
  }
  await expect(page.getByText('架构师')).toBeVisible();
  await expect(page.getByText('前端开发 #2')).toBeVisible();
  await expect(page.getByText('steward')).toBeVisible();

  // 回根台进任务详情看事件日志
  await page.getByRole('link', { name: '根' }).click();
  await page.getByRole('link', { name: 'e2e 派发任务' }).click();
  await expect(page.getByText('事件日志')).toBeVisible();
  await expect(page.getByText('task_assigned')).toBeVisible();

  // 反提案 → 顶栏待处理变 1
  await page.getByRole('button', { name: '反提案' }).click();
  await page.getByTestId('respond-reason').fill('范围需要调整');
  await page.getByTestId('respond-dialog').getByRole('button', { name: '提交' }).click();
  await expect(page.getByText('待处理 1')).toBeVisible();
});
