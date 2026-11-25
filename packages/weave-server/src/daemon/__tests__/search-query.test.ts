import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../search-query.js';

describe('parseSearchQuery', () => {
  it('纯文本：terms=[q]、scopes 全 true、无过滤（联邦兼容基线）', () => {
    const p = parseSearchQuery('部署脚本');
    expect(p.terms).toEqual(['部署脚本']);
    expect(p.excludes).toEqual([]);
    expect(p.scopes).toEqual({ sessions: true, messages: true, files: true, content: true });
    expect(p.projectId).toBeNull();
    expect(p.projectName).toBeNull();
    expect(p.sessionId).toBeNull();
    expect(p.sessionTitle).toBeNull();
    expect(p.text).toBe('部署脚本');
  });

  it('裸 in 不触发限定（普通词落 terms）', () => {
    const p = parseSearchQuery('in');
    expect(p.terms).toEqual(['in']);
    expect(p.scopes).toEqual({ sessions: true, messages: true, files: true, content: true });
  });

  it(':主形分类限定；空值（光标停在冒号上）忽略', () => {
    const p = parseSearchQuery('部署 :chat');
    expect(p.terms).toEqual(['部署']);
    expect(p.scopes.messages).toBe(true);
    expect(p.scopes.files).toBe(false);
    const empty = parseSearchQuery(':');
    expect(empty.terms).toEqual([]);
    expect(empty.scopes).toEqual({ sessions: true, messages: true, files: true, content: true });
  });

  it('in: 已退役：整个 token 落 terms（in 不再是语法）', () => {
    const p = parseSearchQuery('部署 in:chat');
    expect(p.terms).toEqual(['部署', 'in:chat']);
    // 无 `:` 限定 ⇒ 四路全搜（in:chat 只是一段普通文本）
    expect(p.scopes.messages).toBe(true);
  });

  it('引号短语含空格算一个 term', () => {
    const p = parseSearchQuery('"exact phrase" tail');
    expect(p.terms).toEqual(['exact phrase', 'tail']);
    expect(p.text).toBe('exact phrase tail');
  });

  it('-word 与 -:chat 进 excludes', () => {
    const p = parseSearchQuery('deploy -draft -:messages');
    expect(p.terms).toEqual(['deploy']);
    expect(p.excludes).toEqual(['draft']);
    expect(p.scopes.messages).toBe(false);
    expect(p.scopes).toMatchObject({ sessions: true, files: true, content: true });
  });

  it(': 叠加与别名；有任一限定时其余 scope 为 false', () => {
    const p = parseSearchQuery('x :chat :files');
    expect(p.scopes).toEqual({ sessions: false, messages: true, files: true, content: false });
    const code = parseSearchQuery('x :code');
    expect(code.scopes.content).toBe(true);
    const names = parseSearchQuery('x :session');
    expect(names.scopes.sessions).toBe(true);
  });

  it(': 未知值按普通词容错', () => {
    const p = parseSearchQuery(':whatever');
    expect(p.terms).toEqual([':whatever']);
    expect(p.scopes.sessions).toBe(true);
  });

  it('project: 数字 → projectId；名字 → projectName', () => {
    expect(parseSearchQuery('project:3 x').projectId).toBe(3);
    expect(parseSearchQuery('project:weave x').projectName).toBe('weave');
    expect(parseSearchQuery('project:weave x').projectId).toBeNull();
  });

  it('session: id 形 vs 标题形分流', () => {
    const id = parseSearchQuery('session:ffe252b3-4b95-400a-a6ef-0b6f5503d553');
    expect(id.sessionId).toBe('ffe252b3-4b95-400a-a6ef-0b6f5503d553');
    expect(id.sessionTitle).toBeNull();
    const title = parseSearchQuery('session:串口调试');
    expect(title.sessionTitle).toBe('串口调试');
    expect(title.sessionId).toBeNull();
  });

  it('空值限定符按普通词', () => {
    const p = parseSearchQuery('project: x');
    expect(p.terms).toEqual(['project:', 'x']);
    expect(p.scopes).toEqual({ sessions: true, messages: true, files: true, content: true });
  });

  it('只有过滤词没有 terms：text 为空', () => {
    const p = parseSearchQuery(':chat project:weave');
    expect(p.terms).toEqual([]);
    expect(p.text).toBe('');
    expect(p.scopes.messages).toBe(true);
    expect(p.projectName).toBe('weave');
  });

  it('未闭合引号：剩余段按短语收', () => {
    const p = parseSearchQuery('open "phrase');
    expect(p.terms).toEqual(['open', 'phrase']);
  });
});
