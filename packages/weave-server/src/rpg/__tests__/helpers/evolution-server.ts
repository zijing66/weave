import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../../db/db.js';
import { ProjectRepository } from '../../../repositories/projects.js';
import { SessionRepository } from '../../../repositories/sessions.js';
import { HookEventRepository } from '../../../repositories/hook-events.js';
import { MessageDeliverer } from '../../../hooks/message-deliverer.js';
import { createWeaveServer } from '../../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../../daemon/settings.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../../roles.js';
import type { ProjectOpener } from '../../../daemon/opener.js';

/** 进化闭环 e2e 的 server 工厂（见 profile.test.ts 消费方）。 */
export async function makeEvolutionServer(): Promise<{
  server: Server;
  port: number;
  db: DatabaseSync;
  cleanup: () => void;
}> {
  const db = openDatabase(':memory:');
  setDaemonSettingsDb(db);
  await writeDaemonSettings({
    terminal: { preset: 'auto', customCommand: '' },
    locale: 'zh-CN',
    hooks: { enabled: true },
  });
  const rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-evo-roles-'));
  const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-evo-hooks-'));
  const handbookRoot = mkdtempSync(path.join(tmpdir(), 'weave-evo-handbook-'));
  const opener: ProjectOpener = {
    openExplorer: async () => {},
    openTerminal: async () => {},
    runInTerminal: async () => {},
  };
  const projects = new ProjectRepository(db);
  const server = createWeaveServer({
    projects,
    port: 0,
    harnesses: createRuntimeRegistry(),
    opener,
    hooksDir: hooksTmp,
    rpgRoles: new RpgRoleRepository(db),
    rpgGrowth: new RpgGrowthRepository(db),
    rpgRolesRoot: rolesRoot,
    rpgHandbookRoot: handbookRoot,
    messageDeliverer: new MessageDeliverer({
      sessions: new SessionRepository(db),
      projects,
      hookEvents: new HookEventRepository(db),
      hooksDir: hooksTmp,
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, db, cleanup: () => setDaemonSettingsDb(null) };
}
