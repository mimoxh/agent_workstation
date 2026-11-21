import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 外部引擎：成员里切到 fake harness → 手动运行 → 任务页「终端」里看到真实终端输出，并能打字接管
test('外部引擎：切换引擎、在应用内终端里看输出并接管输入', async ({ page }) => {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; parentId: string | null; pluginId: string }[] };
  const parentId = proj.workstations.find((w) => w.parentId === null)!.id;
  const seeded = proj.workstations.find((w) => w.pluginId === 'dev')!.id;
  const { source } = (await (await fetch(`${api}/api/workstations/${seeded}/qa/overview`)).json()) as { source: { repoPath: string; targetBranch: string } };
  const ws = (await (await fetch(`${api}/api/projects/proj-aw/workstations`, json({ parentId, pluginId: 'dev', name: `开发${Date.now()}`, settings: { repoPath: source.repoPath, targetBranch: source.targetBranch } }))).json()) as { id: string };
  const detail = (await (await fetch(`${api}/api/workstations/${ws.id}`)).json()) as { agents: { id: string; name: string }[] };
  const fe = detail.agents.find((a) => a.name === '前端开发')!;

  await page.goto(`/projects/proj-aw/ws/${ws.id}?panel=_agents`);
  const row = page.getByTestId('agent-row').filter({ hasText: '前端开发' });
  await row.getByRole('button', { name: '编辑' }).click();
  const engine = page.getByTestId('agent-engine');
  await expect(engine.locator('option[value="fake"]')).toBeEnabled();
  await engine.selectOption('fake');
  const model = page.getByTestId('agent-model');
  await expect(model).toBeEnabled();
  await model.selectOption('fake-fast');
  await page.getByTestId('agent-dialog').getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('agent-dialog')).toHaveCount(0);
  await expect(row.getByTestId('agent-engine-cell')).toContainText('Fake');
  await expect(row.getByTestId('agent-engine-cell')).toContainText('fake-fast');

  const t = (await (await fetch(`${api}/api/workstations/${ws.id}/tasks`, json({ title: 'e2e外部引擎', input: { kind: 'feature', priority: 'p2', module: 'src/board' } }))).json()) as { id: string };
  const started = (await (await fetch(`${api}/api/agents/${fe.id}/run`, json({ taskId: t.id }))).json()) as { runId: string };
  expect(started.runId).toBeTruthy();

  await page.goto(`/projects/proj-aw/tasks/${t.id}?view=terminal`);
  const term = page.getByTestId('terminal');
  await expect(term.getByTestId('terminal-live')).toBeVisible({ timeout: 20000 });
  const screen = term.locator('.xterm-rows');
  await expect(screen).toContainText('fake harness', { timeout: 20000 });
  await expect(screen).toContainText('send_message');

  // 人接管：点进终端打字，harness 收到输入并回显
  await term.getByTestId('terminal-screen').click();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('echo:', { timeout: 10000 });

  // run 页同一个终端；第一回合结束后 run 收口
  await page.goto(`/projects/proj-aw/runs/${started.runId}`);
  await expect(page.getByTestId('terminal').locator('.xterm-rows')).toContainText('fake harness', { timeout: 20000 });
  await expect(page.getByTestId('run-page')).toContainText('引擎 fake · fake-fast');
});
