import { expect, test, type Page } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

// 新建会话后列表要等实时失效刷新，期间右侧在 Empty/ThreadView 之间换，输入要等人就位
async function typeAndSend(page: Page, text: string) {
  const input = page.getByTestId('thread-input');
  await expect.poll(async () => {
    await input.fill(text);
    return page.getByTestId('thread-send').isEnabled();
  }, { timeout: 20000 }).toBe(true);
  await page.getByTestId('thread-send').click();
}

test('smoke：侧栏默认负责人私聊可切大群；Agent 页建私聊和群聊能发消息', async ({ page }) => {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; pluginId: string }[] };
  const dev = proj.workstations.find((w) => w.pluginId === 'dev')!;

  await page.goto(`/projects/proj-aw/ws/${dev.id}?panel=_talk`);
  await expect(page.getByTestId('agent-talk')).toBeVisible();

  const ws = (await (await fetch(`${api}/api/workstations/${dev.id}`)).json()) as { agents: { id: string; name: string; isSteward: number }[] };
  const architect = ws.agents.find((a) => a.name === '架构师')!;
  const fe = ws.agents.find((a) => a.name === '前端开发')!;
  expect(architect.isSteward).toBe(1);

  await page.getByTestId('conv-new-open').click();
  await page.getByTestId(`conv-member-${fe.id}`).check();
  await page.getByRole('button', { name: '开始私聊' }).click();
  await expect(page).toHaveURL(/thread=/);
  await typeAndSend(page, '在吗');
  await expect(page.getByText('收到（mock）。').first()).toBeVisible({ timeout: 20000 });

  await page.getByTestId('conv-new-open').click();
  await page.getByTestId(`conv-member-${architect.id}`).check();
  await page.getByTestId(`conv-member-${fe.id}`).check();
  await page.getByRole('button', { name: '建群' }).click();
  await expect(page).toHaveURL(/thread=/);
  await typeAndSend(page, '对齐一下接口');
  await expect(page.getByTestId('decision-card').first()).toBeVisible({ timeout: 30000 });

  // 文档台右侧栏：默认负责人（主笔）私聊，可切大群
  const docs = proj.workstations.find((w) => w.pluginId === 'docs');
  if (docs) {
    await page.goto(`/projects/proj-aw/ws/${docs.id}`);
    await expect(page.getByTestId('chat-rail-target')).toHaveValue(/^dm:/);
    await page.getByTestId('chat-rail-target').selectOption('ws');
    await expect(page.getByTestId('chat-rail-target')).toHaveValue('ws');
  }
});
