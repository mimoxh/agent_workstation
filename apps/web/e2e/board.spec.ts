import { expect, test } from '@playwright/test';

test('项目 → 开发工作台 → 新建任务 → 派发', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Agent Workstation', { exact: true }).click();

  // 进入项目后跳到根工作台；再点「开发」进入领域工作台
  await expect(page.getByText('工作台树')).toBeVisible();
  await page.getByRole('link', { name: '开发' }).click();
  await expect(page.getByTestId('task-board')).toBeVisible();

  // 新建任务 → 出现在「草稿」列
  await page.getByTestId('new-task-title').fill('e2e 冒烟任务');
  await page.getByRole('button', { name: '新建任务' }).click();
  const draftCol = page.getByTestId('board-column-草稿');
  await expect(draftCol.getByText('e2e 冒烟任务')).toBeVisible();

  // 派发 → 移到「已派发」列
  const card = draftCol.locator('[data-task-title="e2e 冒烟任务"]');
  await card.getByRole('button', { name: '派发' }).click();
  await expect(
    page.getByTestId('board-column-已派发').getByText('e2e 冒烟任务'),
  ).toBeVisible();
});
