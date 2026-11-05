import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { NotifyChannelRepository } from '../notify-channels.js';

/** 外发通道存储：config JSON 往返、启用过滤、CRUD。 */

let db: DatabaseSync;
let repo: NotifyChannelRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new NotifyChannelRepository(db);
});

afterEach(() => db.close());

describe('NotifyChannelRepository', () => {
  it('创建 / 取回 / 列表，config 原样往返', () => {
    const created = repo.create({
      kind: 'dingtalk',
      name: '团队群',
      config: { url: 'https://dd.example/robot?access_token=t', secret: 's' },
    });
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    expect(repo.getById(created.id)!.config).toEqual({
      url: 'https://dd.example/robot?access_token=t',
      secret: 's',
    });
    expect(repo.list()).toHaveLength(1);
  });

  it('listEnabled 只回启用的', () => {
    repo.create({ kind: 'wecom', name: 'a', config: { url: 'https://a' } });
    repo.create({ kind: 'wecom', name: 'b', config: { url: 'https://b' }, enabled: false });
    expect(repo.listEnabled().map((c) => c.name)).toEqual(['a']);
  });

  it('更新部分字段时其余保持不变', () => {
    const c = repo.create({ kind: 'feishu', name: 'a', config: { url: 'https://a', secret: 's' } });
    const updated = repo.update(c.id, { name: 'b', enabled: false })!;
    expect(updated.name).toBe('b');
    expect(updated.enabled).toBe(false);
    expect(updated.config).toEqual({ url: 'https://a', secret: 's' });
  });

  it('删除；不存在返回 false', () => {
    const c = repo.create({ kind: 'pushplus', name: 'p', config: { token: 't' } });
    expect(repo.delete(c.id)).toBe(true);
    expect(repo.getById(c.id)).toBeUndefined();
    expect(repo.delete(c.id)).toBe(false);
  });
});
