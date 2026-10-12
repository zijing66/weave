// docs-reminder — CC 原生 classic hook（派生自 fixtures/changelog-reminder）。
// 内置包静态闸：全树禁 node 内建模块引入与 CommonJS 加载调用 —— 只用进程全局读 stdin。
// PostToolUse 语义：exit 2 时 stderr 作为提醒喂给当前会话。
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const tool = payload.tool_name || '';
  if (tool !== 'Edit' && tool !== 'Write' && tool !== 'NotebookEdit') process.exit(0);
  const file = (payload.tool_input && payload.tool_input.file_path) || '';
  if (!/\.md$/i.test(file)) process.exit(0);
  process.stderr.write(
    '文档一致性提醒：刚修改了 ' +
      file +
      '。请检查相关 Markdown 文档（README / CHANGELOG / docs/）是否需要同步更新；过期内容请直接修改。',
  );
  process.exit(2);
});
