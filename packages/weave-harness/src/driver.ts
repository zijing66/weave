import type { Harness } from '@weave/core';
import type { InitContext, InitPipeline } from './init/pipeline.js';
import type { FileAssetCategory } from './shared/file-specs.js';

/**
 * 抽象定义的家：五种能力接口 + HarnessDriver + HarnessRegistry + supports。
 * 依赖硬约束：本包仅依赖 @weave/core（永不依赖 server/cli，防 statusline/i18n 成环）。
 */

/** 五种可插拔能力槽——driver 声明持有哪些，注册表按能力检索。 */
export type HarnessCapability = 'init' | 'events' | 'assets' | 'resume' | 'detect';

/** init 槽类型：以 InitContext 构造 InitPipeline 子类（图① InitTemplateClass）。 */
export type InitTemplateClass = new (ctx: InitContext) => InitPipeline;

/**
 * 事件接入源——字段名保留 `source`，结构兼容 server 的 HookAdapter
 * （实现见 `claude/event-source.ts`，批 4b 迁入）。
 */
export interface EventSource {
  readonly source: Harness;
  readonly events: readonly string[];
  normalize(report: unknown, projectId: number): unknown;
}

/**
 * 资产落盘表面查询（批 4a 补全）：「某 harness 的资产落哪 / 怎么分类」的知识
 * 从 server 六处散落收敛进本接口的实现（`claude/assets.ts` / `codex/assets.ts`），
 * server 保留原函数名作薄委托——`fileAssetTargetDir` / `skillsDirFor` /
 * `classifyAgent` / `shouldIgnore` / global-config skills 常量 / codex-toml 路径。
 */
export interface AssetSurface {
  /** 所属 harness——按序遍历多个 surface 时回指归属（`classifyAgent` 消费）。 */
  readonly harness: Harness;

  /** 某资产类别在指定 scope 的目标目录；无该表面则抛错（同 `fileAssetTargetDir` 语义）。 */
  targetDir(
    category: FileAssetCategory,
    scope: 'project' | 'global',
    projectPath: string,
    homedir: string,
  ): string;

  /** 项目内 skills 目录（相对项目根，posix 分隔；`skillsDirFor` 消费）。 */
  projectSkillsDir(): string;

  /**
   * 全局 skills 根（绝对路径）：[0] 为安装写入目标，其后为只读遗留根
   * （Codex 的 deprecated `~/.codex/skills`；global-config 消费）。
   */
  globalSkillsRoots(homedir: string): string[];

  /** weave 增量编辑的用户级配置文件（Claude `~/.claude/settings.json`；Codex `~/.codex/config.toml`）。 */
  userConfigFile(homedir: string): string;

  /**
   * 路径归属：该相对路径（posix 已归一）是否认领为本 harness 表面
   * （`classifyAgent` 消费——按 codex→claude 顺序找首个认领者，无人认领默认 claude）。
   */
  classify(relPath: string): boolean;

  /**
   * watch 忽略：本 harness 视角下该相对路径是否不在观测集
   * （`shouldIgnore` 消费——两面取 AND，任一 surface 观测即保留；
   * 项目根与 `.weave` 是中立规则，留在 server 的 `shouldIgnore`）。
   */
  ignore(relPath: string): boolean;
}

/** resume 执行规格——`args` 签名对齐 `resume-runner.ts` 现状调用（sessionId, prompt）。 */
export interface ResumeCommandSpec {
  /** false = 该 harness 无 resume 对等物（501 语义）。 */
  supported: boolean;
  /** 可执行文件名（如 `claude`；runner 可用环境变量覆盖）。 */
  bin: string;
  /** 拼 spawn 参数，如 `['--resume', sessionId, '-p', prompt]`。 */
  args(sessionId: string, prompt: string): string[];
}

/** detect 返回结构（批 5 定）：harness 标识 + `dir` 下是否命中其标记。 */
export interface DetectResult {
  harness: Harness;
  present: boolean;
}

/** 探测策略——scan/status 认 harness 标记，批 5 消费（scan/status/meta 三处）。 */
export interface Detector {
  /** 识别标记（如 `.claude` / `CLAUDE.md`）。 */
  markers: readonly string[];
  /** `dir` 下是否命中该 harness 标记。 */
  present(dir: string): boolean;
  /** 执行探测并返回结果。 */
  detect(dir: string): DetectResult;
}

/** 单个 harness 的驱动：id/displayName 必填，五个能力槽按批次补齐。 */
export interface HarnessDriver {
  id: Harness;
  displayName: string;
  capabilities: readonly HarnessCapability[];
  init?: InitTemplateClass;
  events?: EventSource;
  assets?: AssetSurface;
  resume?: ResumeCommandSpec;
  detect?: Detector;
}

/**
 * 能力槽注册表：先到先得（同 id 重复注册抛错，对齐插件先加载者胜）；
 * `register` 返回 disposer 恢复注册前快照（cordis effect 语义）。
 */
export class HarnessRegistry {
  private readonly drivers = new Map<Harness, HarnessDriver>();

  /** 注册驱动；重复 id 抛错。disposer 幂等，只移除自己注册的那份（不误删后继同 id 注册）。 */
  register(driver: HarnessDriver): () => void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`harness driver already registered: ${driver.id}`);
    }
    this.drivers.set(driver.id, driver);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.drivers.get(driver.id) === driver) this.drivers.delete(driver.id);
    };
  }

  /** 按 id 取驱动，缺失返回 undefined。 */
  get(id: Harness): HarnessDriver | undefined {
    return this.drivers.get(id);
  }

  /** 全部驱动（注册顺序的快照数组）。 */
  all(): HarnessDriver[] {
    return [...this.drivers.values()];
  }

  /** 声明了该能力的驱动（按注册顺序）。 */
  byCapability(capability: HarnessCapability): HarnessDriver[] {
    return this.all().filter((d) => d.capabilities.includes(capability));
  }

  /** 取某 harness 的 init 槽类型；未注册或未补槽返回 undefined。 */
  initFor(id: Harness): InitTemplateClass | undefined {
    return this.drivers.get(id)?.init;
  }

  /** 按 id 移除驱动；返回是否存在。 */
  unregister(id: Harness): boolean {
    return this.drivers.delete(id);
  }
}

/** driver 是否声明拥有该能力。 */
export function supports(driver: HarnessDriver, capability: HarnessCapability): boolean {
  return driver.capabilities.includes(capability);
}
