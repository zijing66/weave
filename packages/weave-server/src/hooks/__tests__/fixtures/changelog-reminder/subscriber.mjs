// 扩展点⑦：只读订阅 PostToolUse 事件流，把观察到的事件写进
// globalThis 供验收测试断言（插件与 daemon 同进程执行）。
export default {
  onEvent(ctx) {
    const seen = (globalThis.__changelogReminderEvents ??= []);
    seen.push(ctx.eventType);
  },
};
