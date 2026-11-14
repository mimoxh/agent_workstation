import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

test('文件夹项目：根工作台文件夹面板浏览并打开文件', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-e2e-folder-'));
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), '# 调研笔记\n\nE2E 文件夹内容。\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inner.txt'), 'inner\n');

    const created = (await (
      await fetch(`${api}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `E2E 文件夹${Date.now()}`, folder: dir }) })
    ).json()) as { id: string };
    const proj = (await (await fetch(`${api}/api/projects/${created.id}`)).json()) as { workstations: { id: string; parentId: string | null }[] };
    const rootId = proj.workstations.find((w) => w.parentId === null)!.id;

    await page.goto(`/projects/${created.id}/ws/${rootId}?panel=folder`);
    await expect(page.getByTestId('folder-tree')).toBeVisible();

    // 根目录条目：目录在前，notes.md 在列
    await expect(page.getByTestId('folder-entry').filter({ hasText: 'notes.md' })).toBeVisible();
    await expect(page.getByTestId('folder-entry').filter({ hasText: 'sub/' })).toBeVisible();

    // 打开 notes.md 看内容
    await page.getByTestId('folder-entry').filter({ hasText: 'notes.md' }).click();
    await expect(page.getByTestId('file-view')).toBeVisible();
    await expect(page.getByTestId('file-view')).toContainText('E2E 文件夹内容');

    // 进子目录再回来
    await page.getByTestId('folder-entry').filter({ hasText: 'sub/' }).click();
    await expect(page.getByTestId('folder-entry').filter({ hasText: 'inner.txt' })).toBeVisible();
    await page.getByRole('button', { name: '根' }).click();
    await expect(page.getByTestId('folder-entry').filter({ hasText: 'notes.md' })).toBeVisible();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
