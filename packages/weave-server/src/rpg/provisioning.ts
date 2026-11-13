import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { generateToken } from '../daemon/auth.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { OrchestrationRepository } from '../repositories/orchestrations.js';
import { projectKey } from '../repositories/projects.js';
import { getAuthPath, getRpgHandbookRoot, getRpgRolesRoot, getSuperagentRoot } from '../db/paths.js';
import { WEAVE_VERSION } from '../version.js';
import { readDaemonState } from '../daemon/state.js';
import type { McpServerConfig } from '@weavecode/harness';
import { generateHookHandler } from '@weavecode/harness';
import { generateSettingsJson, mergeSettingsJson, statusLineIsWeave } from '@weavecode/harness';
import { DEFAULT_HOOKS, type PlatformInfo } from '@weavecode/core';
import { RpgRoleRepository, archetypeBaseline, type Hexagon, type RpgRoleRow } from './roles.js';
import { ROLE_MANIFEST_KEY, readRoleManifest, type RoleManifest } from './role-plugin.js';
import { BUILTIN_ROLE_TEMPLATES, COORDINATOR_PERSONA, COORDINATOR_SKILLS, handbookPersonaSection } from '../install/role-manifests.js';
import { BUILTIN_MCP_SERVERS } from '../install/builtin-mcp.js';

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
  /** 测试注入缝：内置 MCP 的 daemon 端口与本机令牌（缺省读 daemon state + auth.json）。 */
  mcpEndpoint?: { port: number; token: string | null };
  /** 编排仓储（可选）：随脚手架物化出厂示例编排（记忆出口节点演示，停用态）。 */
  orchestrations?: Pick<OrchestrationRepository, 'insert' | 'list'>;
}

// ---- 内建仓库项目档 MCP + 托管 ignore（E4 验收⑥）----

/**
 * 内建仓库的 `.mcp.json`：四枚内置服务按 Streamable HTTP 形态写进项目档——
 * url 用 daemon 当前端口（安装面 mcp-rows 同口径），令牌进 `x-weave-local` 头
 * （值读 `<local>/auth.json`，与 market 路由装 user 档时的既有取数一致）。
 * 幂等合并：已有的键不覆盖（用户的），只补缺的四键。
 */
async function ensureBuiltinMcp(dir: string, endpoint?: ProvisionDeps['mcpEndpoint']): Promise<void> {
  const port = endpoint?.port ?? readDaemonState()?.port ?? 6420;
  let token = endpoint?.token ?? null;
  if (token == null) {
    try {
      const auth = JSON.parse(await readFile(getAuthPath(), 'utf-8')) as { localToken?: unknown };
      token = typeof auth.localToken === 'string' ? auth.localToken : null;
    } catch {
      token = null;
    }
  }
  const file = path.join(dir, '.mcp.json');
  let json: { mcpServers?: Record<string, unknown> };
  try {
    json = JSON.parse(await readFile(file, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    if (json == null || typeof json !== 'object' || Array.isArray(json)) json = {};
  } catch {
    json = {};
  }
  const servers = { ...(json.mcpServers ?? {}) };
  for (const builtin of BUILTIN_MCP_SERVERS) {
    if (builtin.name in servers) continue;
    const config: McpServerConfig = {
      type: 'http',
      url: `http://127.0.0.1:${port}/api${builtin.path}`,
      ...(token ? { headers: { 'x-weave-local': token } } : {}),
    };
    servers[builtin.name] = config;
  }
  if (Object.keys(servers).length > 0) json.mcpServers = servers;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}

/**
 * 托管 `.gitignore`：`.mcp.json` 带着本机令牌，不该进版本历史——内建仓库的根
 * ignore 追加一行（已有该行 = no-op；没有文件 = 创建）。只追加、不覆写用户内容。
 */
async function ensureMcpJsonIgnored(dir: string): Promise<void> {
  const file = path.join(dir, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(file, 'utf-8');
  } catch {
    /* 无文件 = 新建 */
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((l) => l.trim() === '.mcp.json')) return;
  const joined =
    existing === ''
      ? '.mcp.json\n'
      : (existing.endsWith('\n') ? existing : `${existing}\n`) + '.mcp.json\n';
  await writeFile(file, joined, 'utf-8');
}

/**
 * 内建仓的项目档采集安装（幂等）：hook-handler 脚本 + `.claude/settings.json`
 * 的 weave 采集组。与 `weave init` 同源——组形（`captureHookGroup`）、脚本正文
 * （`generateHookHandler`）、settings 合并（`mergeSettingsJson`）全部出自 harness
 * 单源，这里只做编排。不装 statusline（出厂仓对话页有它即可，不需要终端条）。
 */
async function ensureProjectCapture(dir: string): Promise<void> {
  const helpersDir = path.join(dir, '.claude', 'helpers');
  await mkdir(helpersDir, { recursive: true });
  await writeFile(
    path.join(helpersDir, 'hook-handler.cjs'),
    generateHookHandler(WEAVE_VERSION),
    'utf-8',
  );
  const file = path.join(dir, '.claude', 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* 缺文件/坏文件 = 新建 */
  }
  const platform: PlatformInfo = {
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    nodeVersion: process.version,
    shell: process.platform === 'win32' ? 'powershell' : 'sh',
    homeDir: homedir(),
    configDir: homedir(),
  };
  const generated = generateSettingsJson({
    components: {
      settings: true,
      skills: false,
      commands: false,
      agents: false,
      helpers: true,
      mcp: false,
      claudeMd: false,
      agentsMd: false,
    },
    hooks: DEFAULT_HOOKS,
    platform,
    helpersDir,
  });
  const merged = mergeSettingsJson(existing, generated);
  // statusLine 指向不物化的 statusline.cjs（components 只有 helpers 开着时它跟
  // hooks 同门）——出厂仓不需要终端条，摘掉避免宿主每轮跑一个不存在的脚本。
  if (statusLineIsWeave(merged['statusLine'])) delete merged['statusLine'];
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
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
        gender: RpgRoleRow['gender'];
        appearanceSeed: RpgRoleRow['appearanceSeed'];
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
    gender?: RpgRoleRow['gender'];
    appearanceSeed?: number;
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
        gender: role.gender,
        appearanceSeed: role.appearanceSeed,
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
  // 内置 MCP 收口（E4 验收⑥）：编排/协调链的消费者只有角色仓库的会话——全集写
  // 项目档（token 不进版本历史），任意项目不再每会话背一万+ token 的 schema 税。
  await ensureBuiltinMcp(dir, deps.mcpEndpoint).catch(() => {});
  await ensureMcpJsonIgnored(dir).catch(() => {});
  // 项目注册 = 既有域唯一实现（与 weave init/scan 同一份 registerProject 的仓储层）；
  // hidden = 起源头标记内建仓库（GET /projects 原样带出，过滤在 web 消费点）。
  const row = deps.projects.register({ path: dir, name, token: generateToken(), source: 'init', hidden: true });
  const role = deps.roles.create({
    projectId: row.id,
    name,
    archetype: input.archetype ?? null,
    persona: input.persona ?? null,
    hexagon: input.hexagon ?? archetypeBaseline(input.archetype),
    ...(input.gender !== undefined ? { gender: input.gender } : {}),
    ...(input.appearanceSeed !== undefined ? { appearanceSeed: input.appearanceSeed } : {}),
  });
  // 外貌/性别元数据随装备声明落 role.json（agent 读自己档案的同一份文件）。
  await writeFile(
    path.join(dir, '.weave', 'role.json'),
    JSON.stringify(
      {
        skills: input.manifest?.skills ?? [],
        mcp: input.manifest?.mcp ?? [],
        plugins: input.manifest?.plugins ?? [],
        gender: role.gender,
        appearanceSeed: role.appearanceSeed,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return {
    ok: true,
    role: {
      id: role.id,
      projectId: row.id,
      name,
      path: row.path,
      archetype: role.archetype,
      gender: role.gender,
      appearanceSeed: role.appearanceSeed,
      reused: false,
    },
  };
}

// ---- 协调者仓库脚手架（RPG 稿 §四）----

/**
 * 协调者目录结构（teams / playbooks / state 在根——协调工作面；agents/ 收游戏
 * 资产（roles + handbook，2026-11-13 用户裁决）；projects/ 收主项目管理目录）。
 * 协调者 = 普通 weave 会话，没有专属运行时——这里只生成仓库骨架 + README。
 */
export const COORDINATOR_DIRS = ['teams', 'playbooks', 'state', 'agents', 'projects'] as const;

export interface ScaffoldCoordinatorResult {
  ok: true;
  path: string;
  created: string[];
  /** 本次物化进 agents/roles/ 的内置角色模板清单（幂等：已有目录跳过）。 */
  rolesSeeded: string[];
  /** 本次物化进 .claude/skills/ 的出厂 skill 清单（幂等：已有文件跳过）。 */
  skillsSeeded: string[];
  reused: boolean;
  /** weave 升级后出厂内容待更新（stamp ≠ 当前版本）：前端据此出「更新出厂内容」
   *  按钮；用户点击（refreshFactory）或 superagent 会话指挥 AI 覆盖才重物化。 */
  factoryOutdated?: boolean;
}

/** 出厂物化版本戳（`<dir>/.weave/scaffold-version`）：与 WEAVE_VERSION 不同
 *  = weave 升级了，weave 出厂文件（人设/七型模板/skill/README）重写一遍；
 *  用户自建的任何其他文件不碰。**写入 `initVersion` 键**（与 `weave init`
 *  的 `.weave/config.yaml` 同字段）——版本滞后提醒（detectInitVersionLag）
 *  读的就是这个口径，超级代理仓升级后能被同一张提醒网兜住。 */
const SCAFFOLD_STAMP_FILE = 'scaffold-version';
/** 兼容读：无 `initVersion` 键的旧 stamp 整行就是版本号（旧格式第一行 = 版本）。 */
export async function readFactoryStamp(dir: string): Promise<string | null> {
  try {
    const raw = (await readFile(path.join(dir, '.weave', SCAFFOLD_STAMP_FILE), 'utf-8')).trim();
    const m = /^initVersion:\s*(\S+)$/m.exec(raw);
    return m ? m[1]! : raw;
  } catch {
    return null;
  }
}

/**
 * 建/刷新「超级代理项目」（原协调者仓，2026-11-11 用户裁决升格：上帝 =
 * coordinator）：目录骨架 + 出厂文件物化 + 项目注册（superagent 置顶常驻）。
 * singleton（同根复用即刷新）。
 *
 * **更新不覆盖（2026-11-13 用户裁决）**：出厂物化只在首装跑一次（stamp 缺失）；
 * weave 升级后（stamp ≠ 当前版本）**不自动重写**——`factoryOutdated` 置 true
 * 交前端出「更新出厂内容」按钮，用户点击（`refreshFactory`）或 superagent 会话
 * 指挥 AI 覆盖（再调本函数带 `force`）才重物化。
 *
 * git 化（同日裁决）：仓无 `.git` 时 `git init` + 首次全量提交（内置仓默认提交，
 * 用户在 IDE 里看 diff 也能回退）；已有仓不碰（提交与否归用户）。
 * root 缺省 = `<data>/superagent/weave`（getSuperagentRoot，2026-11-11 裁决：
 * 不挂 rpg 域——weave 出厂项目，不是游戏资产）。
 */
export async function scaffoldCoordinator(
  deps: ProvisionDeps,
  root?: string,
  opts?: { force?: boolean },
): Promise<ScaffoldCoordinatorResult> {
  const dir = root ?? getSuperagentRoot();
  const created: string[] = [];
  const rolesSeeded: string[] = [];
  const skillsSeeded: string[] = [];
  const existing = deps.projects.getByPath(dir);
  // 出厂物化判据：首装（stamp 缺失）= 立即物化；版本不同 = 只标待更新（手动按钮）。
  const stamp = await readFactoryStamp(dir);
  const firstInstall = stamp === null;
  const refresh = firstInstall || opts?.force === true;
  const factoryOutdated = !firstInstall && stamp !== WEAVE_VERSION && opts?.force !== true;
  // 旧布局搬迁（2026-11-13）：roles/handbook 从仓根整档 rename 进 agents/（rename
  // 从不删；目标已在则逐项并入——目标往往已被出厂模板占住，整档 rename 会把
  // 存量角色留在根下成孤儿）。逐项 rename 失败就留下原样，只有搬空（目录已空）
  // 才删壳——绝不静默吞用户内容。
  for (const [legacy, target] of [
    ['roles', path.join(dir, 'agents', 'roles')],
    ['handbook', path.join(dir, 'agents', 'handbook')],
  ] as const) {
    const from = path.join(dir, legacy);
    try {
      await stat(from);
      try {
        await stat(target);
        // 目标已在（多半被出厂模板占住）：无同名 → rename；目标已占且源是出厂
        // 模板（无 .weave 标记 = 非用户角色仓，内容与刚重物化的目标同源）→ 删
        // 源；用户角色仓（有 .weave）目标被占时留在原地，绝不删。
        for (const entry of await readdir(from).catch(() => [] as string[])) {
          const src = path.join(from, entry);
          const dst = path.join(target, entry);
          if (!(await stat(dst).then(() => true, () => false))) {
            await rename(src, dst).catch(() => {});
            continue;
          }
          if (legacy === 'roles') {
            const isUserRole = await stat(path.join(src, '.weave')).then(() => true, () => false);
            if (!isUserRole) await rm(src, { recursive: true, force: true }).catch(() => {});
          }
        }
        // 搬空（或只剩已并入的出厂模板）才删壳。
        if ((await readdir(from).catch(() => ['x'])).length === 0) {
          await rm(from, { force: true }).catch(() => {});
        }
      } catch {
        await mkdir(path.dirname(target), { recursive: true });
        await rename(from, target).catch(() => {});
      }
    } catch {
      /* 旧目录不存在 = 新装或已迁 */
    }
  }
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
    const roleDir = path.join(dir, 'agents', 'roles', tpl.id);
    const manifestPath = path.join(roleDir, 'weave-plugin.json');
    const exists = (p: string) => stat(p).then(() => true, () => false);
    // 目录被同名用户角色仓占住（2026-11-11 起角色仓与模板同层）：整条让位——
    // 不 rm 也不写 manifest，两分支共用。
    if (await exists(path.join(roleDir, '.weave'))) continue;
    if (!refresh) {
      if (await exists(manifestPath)) continue; // 已物化过：不覆盖
    } else {
      // 版本刷新：清掉旧模板目录重建（拿到这里的一定不是用户角色仓）。
      await rm(roleDir, { recursive: true, force: true }).catch(() => {});
    }
    await mkdir(roleDir, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          manifestVersion: 1,
          id: tpl.id,
          name: tpl.name,
          version: WEAVE_VERSION,
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
  // MPU 三枚出厂 skill（G6：督导/破局/降级）物化进 .claude/skills/——协调者分身
  // （本仓普通会话）即可用；与角色仓库形态同构，分身出征直接声明进 role.json
  // 走 installKit。版本刷新时重写，版本不变时用户已有同名 = 跳过不覆盖。
  for (const skill of COORDINATOR_SKILLS) {
    const skillDir = path.join(dir, '.claude', 'skills', skill.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!refresh) {
      try {
        await stat(skillFile);
        continue; // 已物化或用户自有：不覆盖
      } catch {
        /* 首次物化 */
      }
    }
    await rm(skillDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFile, skill.body, 'utf-8');
    skillsSeeded.push(skill.name);
  }
  // superagent 注册/升格：新注册走 hidden:false + superagent:true；存量行
  // （旧库 hidden:1）由 register 的 MAX + markSuperagent 翻正——升格是幂等的。
  const row = deps.projects.register({
    path: dir,
    name: 'weave',
    token: generateToken(),
    source: 'init',
    superagent: true,
  });
  if (row.hidden || !row.superagent) deps.projects.markSuperagent(row.id);
  // 存量行还顶着出厂名 coordinator（register 幂等不刷名字）：翻正成 weave——
  // 用户已自己改过名的不动（出厂名才是 coordinator）。
  if (row.name === 'coordinator') deps.projects.rename(row.id, 'weave');
  // 出厂示例编排（记忆出口演示）：只在给了编排仓储时物化；同名即用户资产，
  // 永不覆盖。**它只是演示记忆出口长什么样，不是写入落点**——记忆出口写的是
  // 编排挂靠项目自己的记忆文件（2026-11-12 用户裁决：每项目各一份）。
  if (deps.orchestrations) {
    await ensureExampleOrchestration(deps.orchestrations, row.id).catch(() => {});
  }
  await ensureBuiltinMcp(dir, deps.mcpEndpoint).catch(() => {});
  await ensureMcpJsonIgnored(dir).catch(() => {});
  // 采集面：出厂仓不装 hooks 的话，里面起的会话对 weave 完全不可见（无
  // SessionStart ⇒ 无会话行——用户在列表里找不到自己刚开的会话）。装法与
  // `weave init` 同源（组形/命令表示法/脚本正文都出自 harness 单源）。
  await ensureProjectCapture(dir).catch(() => {});
  await writeFile(
    path.join(dir, 'CLAUDE.md'),
    COORDINATOR_PERSONA + handbookPersonaSection(getRpgHandbookRoot()),
    'utf-8',
  ).catch(() => {
    /* 写不进不挡脚手架 */
  });
  await writeFile(
    path.join(dir, 'README.md'),
    '# 超级代理仓库（上帝）\n\nteams/ 团队声明 · agents/roles/ 内置角色插件 · agents/handbook/ 手法库 · playbooks/ 任务剧本 · state/ 运行素材 · projects/ 主项目管理（projects/<项目>/<会话>/ 收各项目所有会话的全局产物）\n',
    'utf-8',
  ).catch(() => {
    /* 写不进不挡脚手架 */
  });
  await mkdir(path.join(dir, '.weave'), { recursive: true });
  // hook-handler 靠 `.weave/token` 定位采集落点（缺它 = 事件全丢，会话不可见）
  await writeFile(path.join(dir, '.weave', 'token'), `${row.token}\n`, 'utf-8').catch(
    () => {
      /* 写不进不挡脚手架 */
    },
  );
  await writeFile(
    path.join(dir, '.weave', SCAFFOLD_STAMP_FILE),
    `initVersion: ${WEAVE_VERSION}\n`,
    'utf-8',
  ).catch(() => {
    /* stamp 写不进：下次启动会再刷新一遍（重复物化无害） */
  });
  // git 化（2026-11-13 用户裁决）：内置仓默认进版本管理——无 .git 时 init +
  // 全量首提交（出厂内容此后可 diff 可回退）；已有仓不碰（提交与否归用户）。
  await ensureGitRepo(dir, refresh).catch(() => {});
  void existing; // 存量与否只影响 reused 报告；升格路径已由 register+mark 收敛
  return {
    ok: true,
    path: projectKey(dir),
    created,
    rolesSeeded,
    skillsSeeded,
    reused: existing != null,
    ...(factoryOutdated ? { factoryOutdated: true } : {}),
  };
}

/**
 * 内置仓 git 化：无 `.git` 时 `git init` + `add -A` + 首次提交（出厂物完整可
 * 回退的基线）；已有仓不动（用户的提交节奏归用户）。失败静默——git 缺席不该
 * 挡脚手架。`commitAll` = force 刷新后把重物化的出厂文件补一笔提交（同裁决：
 * 默认提交；用户自己提交过的中间态不强制，add -A 会带上用户的未暂存改动，
 * 刷新是用户主动点的、可接受）。
 */
async function ensureGitRepo(dir: string, commitAll: boolean): Promise<void> {
  const git = (args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      const child = spawn('git', ['-C', dir, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  if (!(await stat(path.join(dir, '.git')).then(() => true, () => false))) {
    if (!(await git(['init']))) return;
    // 身份 fallback（本机 2026-11-13 实测：daemon 子进程 env 无 GIT_AUTHOR_*、
    // 全局 user.name 缺失时 commit 静默失败 exit≠0）——写 local config，只兜
    // 缺席（已有全局身份的用户配置原样保留，local 缺省跟随全局）。
    await git(['config', 'user.name', 'weave']).catch(() => {});
    await git(['config', 'user.email', 'weave@local']).catch(() => {});
    await git(['add', '-A']);
    await git(['commit', '-m', 'chore: weave 出厂内容初始化']);
  } else if (commitAll) {
    await git(['add', '-A']);
    await git(['commit', '-m', `chore: weave ${WEAVE_VERSION} 出厂内容更新`]);
  }
}

/**
 * projects/ 目录对齐（2026-11-13 用户裁决：主项目管理收进超级代理仓 projects/，
 * 2026-11-13 二轮改名 project/ → projects/ + 会话层）：每个活跃普通项目一个
 * 子目录（目录名 = 项目名，非法字符换 `-`），带一页占位档案；**会话产物层
 * `projects/<项目>/<会话>/` 归上帝会话维护**（weave 只物化项目层，会话目录由
 * superagent 会话按约定建——会话名/id，全局产物集中地）。项目改名 → 子目录跟着
 * rename（旧名目录有用户内容也搬——改名是用户的明确动作）。归档/hidden/
 * superagent（自身）不出目录。daemon 启动时与 scaffoldCoordinator 同拍跑一次
 * （start.ts / dev-entry.ts），失败静默。
 */
export async function syncProjectDirs(projects: ProjectRepository, root?: string): Promise<void> {
  const saRoot = root ?? getSuperagentRoot();
  const base = path.join(saRoot, 'projects');
  await mkdir(base, { recursive: true }).catch(() => {});
  // 旧名搬迁（2026-11-13 二轮：project/ → projects/）：rename 从不删、目标已在 =
  // 已迁。旧目录若有内容而 projects/ 为空壳（COORDINATOR_DIRS 先 mkdir 过），
  // 把旧内容逐项并进新目录再让位。
  const legacy = path.join(saRoot, 'project');
  try {
    await stat(legacy);
    const targetEmpty = (await readdir(base).catch(() => [])).length === 0;
    if (targetEmpty) {
      await rename(legacy, base).catch(() => {});
    } else {
      const entries = await readdir(legacy).catch(() => [] as string[]);
      let allMoved = entries.length > 0;
      for (const entry of entries) {
        try {
          await rename(path.join(legacy, entry), path.join(base, entry));
        } catch {
          allMoved = false;
        }
      }
      if (allMoved && (await readdir(legacy).catch(() => ['x'])).length === 0) {
        await rm(legacy, { force: true }).catch(() => {});
      }
    }
  } catch {
    /* 旧目录不存在 = 新装或已迁 */
  }
  for (const p of projects.list()) {
    if (p.archivedAt || p.hidden || p.superagent) continue;
    const slug = p.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || `project-${p.id}`;
    const dir = path.join(base, slug);
    try {
      await stat(dir);
      continue; // 已在：不碰内容（档案归上帝会话维护）
    } catch {
      /* 不存在 = 物化 */
    }
    // 旧名目录在（项目改过名）→ 按 .project-id marker 找回并整目录 rename；都
    // 没有才新建。marker 是 weave 物化标记——用户自己建的目录不被误搬。
    const oldDirs = await readdir(base).catch(() => [] as string[]);
    let moved = false;
    for (const old of oldDirs) {
      if (old === slug) continue;
      const marker = path.join(base, old, '.project-id');
      try {
        if ((await readFile(marker, 'utf-8')).trim() === String(p.id)) {
          await rename(path.join(base, old), dir).catch(() => {});
          moved = true;
          break;
        }
      } catch {
        /* 无 marker = 不是 we weave 物化的目录 */
      }
    }
    if (moved) continue;
    await mkdir(dir, { recursive: true }).catch(() => {});
    await writeFile(path.join(dir, '.project-id'), `${p.id}\n`, 'utf-8').catch(() => {});
    await writeFile(
      path.join(dir, 'README.md'),
      `# ${p.name}\n\n- 路径：${p.path}\n- 注册：${p.registeredAt}\n\n（项目档案归超级代理会话维护：目标、关键决定、会话纪要。）\n`,
      'utf-8',
    ).catch(() => {});
  }
}

// ---- 从角色模板实例化（协调者「创建角色」动词的输入）----

/** 出厂示例编排的名字（幂等键：同名即用户资产，永不覆盖）。 */
const EXAMPLE_ORCH_NAME = '记忆出口示例';

/**
 * 超级代理仓的出厂示例编排：手动触发 → 记忆出口两节点的最小形状，入停用态
 * （用户在画布上看见、复制或启用才跑）。演示「记忆出口节点长什么样」。
 */
async function ensureExampleOrchestration(
  orchestrations: NonNullable<ProvisionDeps['orchestrations']>,
  projectId: number,
): Promise<void> {
  const existing = orchestrations
    .list()
    .find((o) => o.projectId === projectId && o.name === EXAMPLE_ORCH_NAME);
  if (existing) return;
  orchestrations.insert({
    name: EXAMPLE_ORCH_NAME,
    projectId,
    startText: '把要沉淀的结论写进手动触发的正文里',
    nodes: [
      { id: 't:memory-demo', kind: 'trigger' },
      { id: 'm:project-verdicts', kind: 'memory' },
    ],
    edges: [
      {
        id: 'e1',
        from: 't:memory-demo',
        to: 'm:project-verdicts',
        text: '沉淀为站立判决：{upstream}',
      },
    ],
    enabled: false,
  });
}

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
