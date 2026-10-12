import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 回归守卫（来自真实故障）：daemon 有两个入口（start.ts 生产 / dev-entry.ts 开发），
 * 二者曾各自手写装配——dev-entry 漏了 mirror + inbox 消费线程，表现为「hook 在写
 * inbox，但 dashboard 一直没有事件」，且没有任何测试会红。
 *
 * 不变量：管道装配只能有一处实现（daemon/hook-pipeline.ts），入口只允许调用它。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, '..');
const read = (file: string) => readFileSync(path.join(daemonDir, file), 'utf8');

describe('hook 文件管道装配：单一实现点', () => {
  it('两个入口都经 wireHookFilePipeline 装配', () => {
    for (const entry of ['start.ts', 'dev-entry.ts']) {
      expect(read(entry)).toContain('wireHookFilePipeline(');
    }
  });

  it('入口不得自行 new MirrorWriter/startInboxWorker/sweep（否则又会漏一环）', () => {
    for (const entry of ['start.ts', 'dev-entry.ts']) {
      const src = read(entry);
      expect(src).not.toContain('new MirrorWriter');
      expect(src).not.toContain('startInboxWorker(');
      expect(src).not.toContain('handleIngestedRecords(');
    }
  });

  it('单一实现点内各环齐全：mirror 重写、worker 消费、记录回主线程处理', () => {
    const src = read('hook-pipeline.ts');
    expect(src).toContain('new MirrorWriter');
    expect(src).toContain('startInboxWorker(');
    expect(src).toContain('handleIngestedRecords(');
    // 规则变更与标题变更都要触发镜像重写
    expect(src).toContain('onChange');
    expect(src).toContain('attachToBus');
  });

  it('入口把 mirror 交给 createWeaveServer（改名/删会话即时重写镜像）', () => {
    for (const entry of ['start.ts', 'dev-entry.ts']) {
      expect(read(entry)).toContain('hookMirror: hookPipeline.mirror');
    }
  });

  it('消费线程的 tick 不得 unref（worker 内无其他 ref 句柄 → 第一 tick 后线程静默退出）', () => {
    const src = readFileSync(path.resolve(daemonDir, '..', 'hooks', 'inbox-worker.ts'), 'utf8');
    const tickLine = src.split('\n').find((l) => l.includes('setInterval(tick'));
    expect(tickLine).toBeDefined();
    expect(tickLine!).not.toContain('unref');
  });
});
