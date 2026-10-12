// md-lint — weave 插件处理器（daemon 内执行，扩展点②）。
// 对刚编辑的 Markdown 做轻量静态检查，命中即注入修复指令。
const CHECKS = [
  { re: /\r\n/g, hint: '统一换行为 LF（仓库内混用 CRLF/LF）' },
  { re: /[ \t]+$/m, hint: '清理行尾空白' },
  { re: /^#{1,6}[^ #]/m, hint: '标题井号后补空格（Markdown 标题语法）' },
  { re: /\t/, hint: '避免制表符缩进（改用空格）' },
];

export default {
  type: 'md-lint',
  execute({ event }) {
    const input = event && event.toolInput;
    const file = (input && input.file_path) || '文档';
    const content = (input && (input.new_string ?? input.content)) || '';
    if (typeof content !== 'string' || content.length === 0) return;
    const hits = CHECKS.filter((c) => c.re.test(content)).map((c) => c.hint);
    if (hits.length === 0) return;
    return {
      additionalContext:
        `Markdown lint（${file}）发现可修复项：\n- ` +
        hits.join('\n- ') +
        '\n请顺手修正以上格式问题（仅格式，不改语义）。',
    };
  },
};
