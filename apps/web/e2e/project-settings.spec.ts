import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

test('项目设置：改名、归档、恢复、删除', async ({ page }) => {
  const created = (await (await fetch(`${api}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'e2e 设置项目' }) })).json()) as { id: string };

  await page.goto(`/projects/${created.id}`);
  await page.getByTestId('side-project-settings').click();
  await expect(page.getByTestId('project-settings')).toBeVisible();
  await page.getByTestId('project-name-setting').fill('e2e 改名项目');
  await page.getByTestId('project-goal-setting').fill('验证项目设置');
  await page.getByTestId('project-settings-save').click();
  await expect(page.getByTestId('project-switcher')).toContainText('e2e 改名项目');

  // 未归档不能删
  await expect(page.getByTestId('project-delete')).toBeDisabled();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('project-archive').click();
  await expect(page.getByTestId('archived-banner')).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('archived-projects')).toContainText('e2e 改名项目');
  await expect(page.getByTestId('project-card').filter({ hasText: 'e2e 改名项目' })).toHaveCount(0);

  await page.getByTestId('archived-projects').getByRole('link', { name: '恢复或删除' }).first().click();
  await page.getByTestId('project-archive').click();
  await expect(page.getByTestId('archived-banner')).toHaveCount(0);

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('project-archive').click();
  await expect(page.getByTestId('archived-banner')).toBeVisible();
  await page.getByTestId('project-delete').click();
  const dialog = page.getByTestId('project-delete-dialog');
  await expect(dialog.getByRole('button', { name: '永久删除' })).toBeDisabled();
  await page.getByTestId('project-delete-confirm').fill('e2e 改名项目');
  await dialog.getByRole('button', { name: '永久删除' }).click();
  await expect(page.getByTestId('command-center')).toBeVisible();
  expect((await fetch(`${api}/api/projects/${created.id}`)).status).toBe(404);
});
