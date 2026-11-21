// 运行时写进 run 目录的小脚本：不依赖源码目录结构，dev（tsx）和 dist 都能用

// 回合结束上报：Claude 的 Stop hook 从 stdin 给 JSON，Codex 的 notify 把 JSON 追加为最后一个参数
// 无论成败都退出 0，不能因为平台没响应就卡住或打断 harness
export const HOOK_SOURCE = `
const [, , source, url, token, arg] = process.argv;
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
async function main() {
  const raw = source === 'claude' ? await readStdin() : (arg ?? '');
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = { raw }; }
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ source, payload }),
    signal: AbortSignal.timeout(8000),
  });
}
main().catch(() => {}).finally(() => process.exit(0));
`;

// 测试用 harness：走真实的 MCP 与回合上报路径，不调模型
// AW_FAKE_MODE：默认完成一回合；exit 直接以 3 退出；hang 不上报回合，并起一个子进程（验证按进程树收尾）
export const FAKE_HARNESS_SOURCE = `
const [mcpUrl, token, hookUrl, sessionId, contextFile] = process.argv.slice(2);
const mode = process.env.AW_FAKE_MODE || 'ok';
const out = (s) => process.stdout.write(s + '\\r\\n');
let id = 0;
async function rpc(method, params) {
  const r = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return r.json();
}
async function turn(last) {
  await fetch(hookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ source: 'fake', payload: { session_id: sessionId, last_message: last, usage: { inputTokens: 120, outputTokens: 30 } } }),
  });
}
async function main() {
  out('fake harness ' + sessionId);
  if (mode === 'exit') { out('boom'); process.exit(3); }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  out('tools: ' + names.join(','));
  const brief = require('fs').readFileSync(contextFile, 'utf8');
  out('context: ' + brief.length + ' chars');
  if (names.includes('send_message')) {
    const r = await rpc('tools/call', { name: 'send_message', arguments: { content: 'fake harness 收到任务' } });
    out('send_message: ' + JSON.stringify(r.result?.content?.[0]?.text ?? r.error));
  }
  if (mode === 'hang') {
    const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    out('child: ' + child.pid);
  } else await turn('fake harness 完成');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (d) => {
    out('echo: ' + JSON.stringify(d));
    if (d.includes('again')) await turn('fake harness 又完成一回合');
    if (d.includes('quit')) process.exit(0);
  });
}
main().catch((e) => { out('fake error ' + e); process.exit(2); });
`;
