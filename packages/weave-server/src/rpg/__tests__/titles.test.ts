import { describe, it, expect } from 'vitest';
import { WEAVE_TITLE_TYPES } from '@weavecode/core';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { RpgRoleRepository } from '../roles.js';
import { RpgExpeditionRepository } from '../expedition-repo.js';
import { rebindExpeditionOnClaim } from '../expedition-session.js';
import { weaveTitle } from '../titles.js';

/**
 * 自动化命名铁则（G6）：词表类型全可拼 + 唯一拼装点语法 + 认领拍身份牌落地
 * （改绑与 title 同拍；title 空不写；只写认领这一拍——手动改名在其后不被覆盖）。
 */

describe('weaveTitle（唯一拼装点）', () => {
  it('语法 = [weave] 类型·主体·语境；cue 为空省尾节', () => {
    expect(weaveTitle({ type: '出征', subject: 'frontend-dev', cue: 'weave' })).toBe('[weave] 出征·frontend-dev·weave');
    expect(weaveTitle({ type: '协调', subject: 'home-1', cue: '  ' })).toBe('[weave] 协调·home-1');
  });

  it('core 词表五类型都能经拼装点出合法形状', () => {
    for (const type of WEAVE_TITLE_TYPES) {
      expect(weaveTitle({ type, subject: 's', cue: 'c' })).toBe(`[weave] ${type}·s·c`);
    }
  });
});

describe('rebindExpeditionOnClaim（认领拍身份牌）', () => {
  it('改绑 + title 同拍落会话行；title 空不写；旧键重复认领 no-op', () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const sessions = new SessionRepository(db);
    const expeditions = new RpgExpeditionRepository(db);
    const p = projects.register({ path: '/tmp/rpg-titles', name: 't', token: 't', source: 'init' });
    const role = roles.create({ projectId: p.id, name: 'squire', archetype: '执行' });
    const titled = expeditions.insert({
      roleId: role.id,
      projectId: p.id,
      sessionKey: 'pending-uuid-1',
      branch: 'weave/session-x',
      anchorBranch: 'main',
      anchorSha: 'abc123',
      title: '[weave] 出征·squire·t',
    });
    const titleless = expeditions.insert({
      roleId: role.id,
      projectId: p.id,
      sessionKey: 'pending-uuid-2',
      branch: 'weave/session-y',
      anchorBranch: 'main',
      anchorSha: 'abc123',
      title: null,
    });
    void titleless;

    const wrote: Array<[string, string]> = [];
    const fakeSessions = {
      setTitle: (sessionId: string, title: string) => {
        wrote.push([sessionId, title]);
        return sessions.setTitle(sessionId, title);
      },
    };

    rebindExpeditionOnClaim({ expeditions, sessions: fakeSessions }, 'pending-uuid-1', 'sess-real-9');
    expect(expeditions.getBySessionKey('sess-real-9')!.id).toBe(titled.id);
    expect(wrote).toEqual([['sess-real-9', '[weave] 出征·squire·t']]);

    // title 空行：改绑照常、不写 title
    rebindExpeditionOnClaim({ expeditions, sessions: fakeSessions }, 'pending-uuid-2', 'sess-real-10');
    expect(expeditions.getBySessionKey('sess-real-10')).toBeDefined();
    expect(wrote).toHaveLength(1);

    // 同一 pending 键重复认领（旧键已消费）= no-op：title 不会第二拍重写
    rebindExpeditionOnClaim({ expeditions, sessions: fakeSessions }, 'pending-uuid-1', 'sess-other');
    expect(wrote).toHaveLength(1);
    expect(expeditions.getBySessionKey('sess-real-9')!.id).toBe(titled.id);
    db.close();
  });

  it('认领落行后手动改名不被自动路径回写（重开 pending 键不存在的行 no-op）', () => {
    const db = openDatabase(':memory:');
    const expeditions = new RpgExpeditionRepository(db);
    const sessions = new SessionRepository(db);
    const wrote: Array<[string, string]> = [];
    rebindExpeditionOnClaim(
      {
        expeditions,
        sessions: {
          setTitle: (sessionId: string, title: string) => {
            wrote.push([sessionId, title]);
            return sessions.setTitle(sessionId, title);
          },
        },
      },
      'pending-not-registered',
      'sess-z',
    );
    expect(wrote).toHaveLength(0); // 没有该登记 = 静默 no-op（既有 rebindSessionKey 语义）
    db.close();
  });
});
