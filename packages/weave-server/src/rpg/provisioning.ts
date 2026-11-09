import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateToken } from '../daemon/auth.js';
import type { ProjectRepository } from '../repositories/projects.js';
import { projectKey } from '../repositories/projects.js';
import { getRpgRolesRoot } from '../db/paths.js';
import { RpgRoleRepository, archetypeBaseline, type Hexagon } from './roles.js';
import { ROLE_MANIFEST_KEY, readRoleManifest, type RoleManifest } from './role-plugin.js';
import { BUILTIN_ROLE_TEMPLATES, COORDINATOR_PERSONA } from '../install/role-manifests.js';

/**
 * 角色 provisioning（RPG 稿 §三 / RPG-1）：建角色 = 建角色仓库（独立 project）+
 * 登记进全局注册表 + RPG 域登记行。**仓库落盘是文件层**（默认
 * `<data>/rpg/roles/<role>/`，settings `rpg.rolesRoot` 可自定义根）；角色属性
 * （skill / MCP = agent 启动自己读的项目文件）写进仓库目录——协议无关，不读
 * ACP / 终端细节。
 *
 * 写侧恒走既有域的单点实现（`ProjectRepository.register` 与 `weave init`/
 * `weave scan` 的注册同一份；token 生成同 `auth.generateToken`）——门面零新裁决。
 * 复用角色 = 已注册项目直接入队（不重建）。
 */

export interface ProvisionDeps {
  projects: ProjectRepository;
  roles: RpgRoleRepository;
  /** 角色仓库根（缺省 `<data>/rpg/roles/`；测试注入临时目录）。 */
  rolesRoot?: string;
}

export type ProvisionRoleResult =
  | {
      ok: true;
      role: {
        id: number;
        projectId: number;
        name: string;
        path: string;
        archetype: string | null;
        /** true = 复用既有项目（未重建仓库）；false = 新建。 */
        reused: boolean;
      };
    }
  | { ok: false; status: 400 | 409; error: string };

const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * 建角色（项目 + 登记 + RPG 行）。同名已注册项目 = 复用（`reused:true`）——
 * 「复用角色 = 已注册项目直接入队（不重建）」；该路径不写人设（仓库是用户的）。
 */
export async function provisionRole(
  deps: ProvisionDeps,
  input: {
    name: string;
    archetype?: string;
    persona?: string;
    hexagon?: Hexagon;
    /** 默认装备清单（来自角色插件 manifest 或调用方显式给；逐项落占位声明文件）。 */
    manifest?: RoleManifest;
  },
): Promise<ProvisionRoleResult> {
  const name = input.name.trim();
  if (!ROLE_NAME_RE.test(name)) {
    return { ok: false, status: 400, error: 'Role name must be kebab-case (a-z 0-9 -)' };
  }
  const root = deps.rolesRoot ?? getRpgRolesRoot();
  const dir = path.join(root, name);
  const existing = deps.projects.getByPath(dir);
  if (existing) {
    // 复用：项目已注册即直接入队，RPG 行缺则补（登记不重建）。
    const role =
      deps.roles.getByProjectId(existing.id) ??
      deps.roles.create({ projectId: existing.id, name, archetype: input.archetype ?? null });
    return {
      ok: true,
      role: {
        id: role.id,
        projectId: existing.id,
        name,
        path: existing.path,
        archetype: role.archetype,
        reused: true,
      },
    };
  }
  try {
    await stat(dir);
    return { ok: false, status: 409, error: `Directory exists but is not registered: ${dir}` };
  } catch {
    /* 不存在 = 正常新建路径 */
  }
  await mkdir(path.join(dir, '.weave'), { recursive: true });
  // 角色属性是文件层的：人设进仓库（agent 启动自己读），默认装备清单落声明文件
  // （修炼/换装动词消费；这里只声明，安装动作仍走既有安装 API）。
  if (input.persona) {
    await writeFile(path.join(dir, 'CLAUDE.md'), input.persona + '\n', 'utf-8');
  }
  if (input.manifest) {
    await writeFile(
      path.join(dir, '.weave', 'role.json'),
      JSON.stringify({ skills: input.manifest.skills, mcp: input.manifest.mcp, plugins: input.manifest.plugins }, null, 2) + '\n',
      'utf-8',
    );
  }
  // 项目注册 = 既有域唯一实现（与 weave init/scan 同一份 registerProject 的仓储层）。
  const row = deps.projects.register({ path: dir, name, token: generateToken(), source: 'init' });
  const role = deps.roles.create({
    projectId: row.id,
    name,
    archetype: input.archetype ?? null,
    persona: input.persona ?? null,
    hexagon: input.hexagon ?? archetypeBaseline(input.archetype),
  });
  return {
    ok: true,
    role: {
      id: role.id,
      projectId: row.id,
      name,
      path: row.path,
      archetype: role.archetype,
      reused: false,
    },
  };
}

// ---- 协调者仓库脚手架（RPG 稿 §四）----

/**
 * 协调者目录结构（teams / roles / playbooks / state）。协调者 = 普通 weave 会话，
 * 没有专属运行时——这里只生成仓库骨架 + README（会话本身走既有 new-session）。
 */
export const COORDINATOR_DIRS = ['teams', 'roles', 'playbooks', 'state'] as const;

export interface ScaffoldCoordinatorResult {
  ok: true;
  path: string;
  created: string[];
  /** 本次物化进 roles/ 的内置角色模板清单（幂等：已有目录跳过）。 */
  rolesSeeded: string[];
  reused: boolean;
}

/**
 * 建「协调者项目」脚手架：目录骨架 + 团队/剧本目录就位。项目注册与建角色同一份
 * 仓储单点；协调者是 singleton（同根复用即 no-op）。root 缺省 = `<rolesRoot>/../
 * coordinator`（注入 rolesRoot 时随注入根走，测试/自定义根同构）。
 *
 * 基础七型角色模板随脚手架物化进 `roles/`（每型一个子目录 = 一份角色插件声明，
 * 声明即模板——实例化 = provisionRole 消费它）。已有目录不覆盖（用户的）。
 */
export async function scaffoldCoordinator(
  deps: ProvisionDeps,
  root?: string,
): Promise<ScaffoldCoordinatorResult> {
  const dir = root ?? path.join(deps.rolesRoot ?? getRpgRolesRoot(), '..', 'coordinator');
  const created: string[] = [];
  const rolesSeeded: string[] = [];
  const existing = deps.projects.getByPath(dir);
  for (const sub of COORDINATOR_DIRS) {
    const target = path.join(dir, sub);
    try {
      await mkdir(target, { recursive: true });
      created.push(sub);
    } catch {
      /* 已存在 = no-op */
    }
  }
  for (const tpl of BUILTIN_ROLE_TEMPLATES) {
    const roleDir = path.join(dir, 'roles', tpl.id);
    try {
      await mkdir(roleDir, { recursive: true });
    } catch {
      continue;
    }
    const manifestPath = path.join(roleDir, 'weave-plugin.json');
    try {
      await stat(manifestPath);
      continue; // 已物化过：不覆盖
    } catch {
      /* 首次物化 */
    }
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          manifestVersion: 1,
          id: tpl.id,
          name: tpl.name,
          version: '0.1.0',
          description: `内置角色插件：${tpl.name}（基础七型）`,
          [ROLE_MANIFEST_KEY]: tpl.role,
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    rolesSeeded.push(tpl.id);
  }
  if (!existing) {
    deps.projects.register({
      path: dir,
      name: 'coordinator',
      token: generateToken(),
      source: 'init',
    });
  }
  try {
    await writeFile(
      path.join(dir, 'CLAUDE.md'),
      COORDINATOR_PERSONA,
      'utf-8',
    );
  } catch {
    /* 写不进不挡脚手架 */
  }
  try {
    await writeFile(
      path.join(dir, 'README.md'),
      '# 协调者仓库\n\nteams/ 团队声明 · roles/ 内置角色插件 · playbooks/ 任务剧本 · state/ 运行素材\n',
      'utf-8',
    );
  } catch {
    /* 已有 README 不覆盖 */
  }
  return { ok: true, path: projectKey(dir), created, rolesSeeded, reused: existing != null };
}

// ---- 从角色模板实例化（协调者「创建角色」动词的输入）----

export type ProvisionFromTemplateResult = ProvisionRoleResult;

/**
 * 从角色插件目录实例化角色：读该目录 manifest 的 `role` 段 → provisionRole。
 * 插件目录 = 协调者仓库 `roles/<id>/weave-plugin.json`（脚手架物化的基础七型），
 * 或市场安装的任意角色插件目录——同一份读取路径。
 */
export async function provisionRoleFromTemplate(
  deps: ProvisionDeps,
  input: { name: string; pluginDir: string },
): Promise<ProvisionFromTemplateResult> {
  let raw: string;
  try {
    raw = await readFile(path.join(input.pluginDir, 'weave-plugin.json'), 'utf-8');
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: `Cannot read role plugin manifest: ${err instanceof Error ? err.message : err}`,
    };
  }
  const role = readRoleManifest(raw);
  if (!role.ok) return { ok: false, status: 400, error: role.error };
  return provisionRole(deps, { name: input.name, manifest: role.role, ...role.role });
}
