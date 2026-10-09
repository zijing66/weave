import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watch as fsWatch } from 'chokidar';
import {
  CLAUDE_HOOK_EVENTS,
  HookRuleSchema,
  PluginRuleEntrySchema,
  WEAVE_PLUGIN_MANIFEST,
  WeavePluginManifestSchema,
  type HookRule,
  type WeavePluginManifest,
} from '@weavecode/core';
import { getDataDir } from '../db/paths.js';
import type { HookRuleRepository } from '../repositories/hook-rules.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import { marketLibraryRoots } from '../market/resolve.js';
import type { HookEventBus } from './bus.js';
import { validateHandler, type HookRuleRegistry } from './registry.js';
import { builtinToolkitRoot, discoverToolkitSources, discoverWeavePackDirs } from './toolkit-scan.js';

/** plugin 处理器返回值：prompt 入池（pending），additionalContext 注入当前会话。 */
export interface PluginHandlerResult {
  additionalContext?: string;
  prompt?: string;
}

/** handler.mjs 的执行上下文（A2 扩展点②的最小服务面）。 */
export interface PluginHandlerContext {
  event: unknown;
  rule: HookRule;
  config: Record<string, unknown>;
  logger: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/** handler.mjs default 导出形状。 */
export interface PluginHandler {
  type: string;
  execute(
    ctx: PluginHandlerContext,
  ): Promise<PluginHandlerResult | void> | PluginHandlerResult | void;
}

/** 插件日志器：统一 `[plugin:<id>]` 前缀（loader 订阅转发与 dispatcher 处理器共用）。 */
export function createPluginLogger(pluginId: string): PluginHandlerContext['logger'] {
  return {
    debug: (msg: string) => console.debug(`[plugin:${pluginId}] ${msg}`),
    info: (msg: string) => console.info(`[plugin:${pluginId}] ${msg}`),
    warn: (msg: string) => console.warn(`[plugin:${pluginId}] ${msg}`),
    error: (msg: string) => console.error(`[plugin:${pluginId}] ${msg}`),
  };
}

/** 订阅模块（扩展点⑦）default 导出形状：只读观察采集事件流。 */
export interface PluginSubscriber {
  onEvent(ctx: {
    eventType: string;
    payload: unknown;
    sessionId: string | null;
    config: Record<string, unknown>;
    logger: PluginHandlerContext['logger'];
  }): void | Promise<void>;
}

/** dispatcher 侧的插件宿主接口（解耦 loader 具体实现，便于测试注入）。 */
export interface PluginHost {
  getHandler(pluginId: string, handlerType: string): PluginHandler | undefined;
  getConfig(pluginId: string): Record<string, unknown>;
  /** ⑦ 事件订阅转发：每个采集事件 fire-and-forget 通知（可选，测试可不实现）。 */
  notifyEvent?(eventType: string, payload: unknown, sessionId: string | null): void;
}

export type PluginLoadStatus = 'active' | 'rejected' | 'disabled';

/** HTTP 路由面的插件管理接口（loader 异步就绪前返回空/失败，不阻塞 daemon 启动）。 */
export interface PluginManager {
  list(): LoadedPluginInfo[];
  setPluginEnabled(pluginId: string, enabled: boolean): boolean;
  /** 重扫全部已登记根（安装/卸载后立即生效，不等热重载防抖）。 */
  reloadAll(): Promise<void>;
  /** 批 10：动态登记工具包扫描根（`add-dir` 时调用；loader 未就绪则跳过）。 */
  loadToolkitRoot?(root: string, scope: 'builtin' | 'global' | 'project', projectId: number | null): Promise<LoadedPluginInfo[]>;
}

export interface LoadedPluginInfo {
  /** manifest.id（manifest 校验失败时回退为目录名）。 */
  id: string;
  name: string;
  version: string;
  dir: string;
  scope: 'builtin' | 'global' | 'project';
  projectId: number | null;
  status: PluginLoadStatus;
  /** rejected/disabled 的原因（校验错误、重复 id、handler 加载失败等）。 */
  error?: string;
  ruleCount: number;
}

/** `@file:` 模板引用前缀：handler.template 写 `@file:prompts/x.md`，加载时内联。 */
const FILE_TEMPLATE_PREFIX = '@file:';

/** 内置工具包根的解析形（loadRoot 跳过该容器子目录用）。 */
function builtinToolkitRootResolved(): string {
  return path.resolve(builtinToolkitRoot());
}

export class WeavePluginLoader implements PluginHost {
  private readonly handlers = new Map<string, PluginHandler>();
  private readonly configs = new Map<string, Record<string, unknown>>();
  private readonly plugins = new Map<string, LoadedPluginInfo>();
  /** ⑦ 事件订阅者：pluginId → {events, subscriber}（disabled/删除时摘除）。 */
  private readonly subscribers = new Map<string, { events: Set<string>; sub: PluginSubscriber }>();
  /** 已登记的扫描根 → 作用域（热重载时按根重扫用；deep = 批 10 工具包深度根）。 */
  private readonly roots = new Map<
    string,
    { scope: 'builtin' | 'global' | 'project'; projectId: number | null; deep?: boolean }
  >();
  private watchStop: (() => void) | undefined;

  constructor(
    private readonly deps: {
      rules: HookRuleRepository;
      registry: HookRuleRegistry;
      states: PluginStateRepository;
      /** 可选：插件变更帧（plugin.reloaded/plugin.toggled）推送源。 */
      bus?: HookEventBus;
    },
  ) {}

  list(): LoadedPluginInfo[] {
    return [...this.plugins.values()];
  }

  getHandler(pluginId: string, handlerType: string): PluginHandler | undefined {
    return this.handlers.get(`${pluginId}:${handlerType}`);
  }

  getConfig(pluginId: string): Record<string, unknown> {
    return this.configs.get(pluginId) ?? {};
  }

  /**
   * 扫描一个插件根目录（其一级子目录各为一个插件包）并加载全部插件。
   * 单个插件失败（校验/重复/handler 加载）只标记 rejected，不影响其他插件。
   * 幂等：同 id 再次加载 = 覆盖式重载（规则 upsert，handler map 替换）；
   * **上次在、本次消失的插件**（目录删除/改坏）规则级联删除、handler 卸载。
   */
  async loadRoot(
    root: string,
    scope: 'builtin' | 'global' | 'project',
    projectId: number | null,
  ): Promise<LoadedPluginInfo[]> {
    const normalizedRoot = path.resolve(root);
    this.roots.set(normalizedRoot, { scope, projectId });

    let entries: string[];
    try {
      entries = await readdir(normalizedRoot);
    } catch {
      return []; // 目录不存在 = 无插件，正常
    }

    const priorIds = this.priorIdsUnder(normalizedRoot);

    const loaded: LoadedPluginInfo[] = [];
    for (const name of entries) {
      const dir = path.join(normalizedRoot, name);
      // 已登记的更深扫描根（批 10：presets/ 下的 harness-tools 树）不作包位，
      // 否则会生成幽灵 rejected 条目并误删深度根注册的插件。
      if (this.roots.has(path.resolve(dir)) || path.resolve(dir) === builtinToolkitRootResolved()) {
        continue;
      }
      const info = await this.loadOne(dir, scope, projectId, name);
      this.plugins.set(info.id, info);
      loaded.push(info);
    }

    return this.finalizeScan(priorIds, loaded);
  }

  /**
   * 批 10：工具包深度扫描根（`presets/harness-tools/<scope>/<pack>/` 与外置
   * `add-dir` 目录）。单层 readdir 见不到 depth-3 嵌套——先递归发现含
   * `weave-plugin.json` 的包位再逐包装载；其余成分（CC 原生/裸表面）由
   * toolkit 服务走文件管线，不进本加载器。
   * 首见的 weave 成分行默认 **停用**（工具包 opt-in：包开关 = plugin_states
   * 级联事实，用户 enable 后才生效）；已有状态行（用户/既有安装）保持不变。
   */
  async loadToolkitRoot(
    root: string,
    scope: 'builtin' | 'global' | 'project',
    projectId: number | null,
  ): Promise<LoadedPluginInfo[]> {
    const normalizedRoot = path.resolve(root);
    this.roots.set(normalizedRoot, { scope, projectId, deep: true });

    const packDirs = await discoverWeavePackDirs(normalizedRoot);
    const priorIds = this.priorIdsUnder(normalizedRoot);

    const loaded: LoadedPluginInfo[] = [];
    for (const dir of packDirs) {
      await this.ensureToolkitDefaultDisabled(dir);
      const info = await this.loadOne(dir, scope, projectId, path.basename(dir));
      this.plugins.set(info.id, info);
      loaded.push(info);
    }
    return this.finalizeScan(priorIds, loaded);
  }

  /** 工具包 weave 成分首见即落 `enabled=false`（无状态行时）。 */
  private async ensureToolkitDefaultDisabled(dir: string): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, WEAVE_PLUGIN_MANIFEST), 'utf8')) as {
        id?: unknown;
      };
      if (typeof raw.id === 'string' && !this.deps.states.get(raw.id)) {
        this.deps.states.setEnabled(raw.id, false);
      }
    } catch {
      // manifest 坏 → 交给 loadOne 标 rejected
    }
  }

  /** 本根上次注册的插件 id（更深注册根名下的不归本根管，防深度/浅层互删）。 */
  private priorIdsUnder(normalizedRoot: string): Set<string> {
    const nested = [...this.roots.keys()].filter(
      (r) => r !== normalizedRoot && r.startsWith(normalizedRoot + path.sep),
    );
    return new Set(
      [...this.plugins.values()]
        .filter((p) => {
          if (!p.dir.startsWith(normalizedRoot + path.sep)) return false;
          return !nested.some((n) => p.dir.startsWith(n + path.sep));
        })
        .map((p) => p.id),
    );
  }

  /** 扫描收尾：消失插件级联删规则/卸 handler，刷新索引并推送重载帧。 */
  private finalizeScan(
    priorIds: Set<string>,
    loaded: LoadedPluginInfo[],
  ): LoadedPluginInfo[] {
    const seenIds = new Set(loaded.map((p) => p.id));
    let removedAny = false;
    for (const id of priorIds) {
      if (seenIds.has(id)) continue;
      this.deps.rules.removeByPlugin(id);
      this.unloadHandlers(id);
      this.configs.delete(id);
      this.plugins.delete(id);
      removedAny = true;
      this.emitReload({ pluginId: id, status: 'rejected', ruleCount: 0, removed: true });
    }

    // 规则变更（upsert/删除/rejected 回滚）后刷新内存索引。
    if (removedAny || loaded.length > 0) this.deps.registry.load();
    for (const info of loaded) {
      this.emitReload({
        pluginId: info.id,
        status: info.status,
        ruleCount: info.ruleCount,
        at: new Date().toISOString(),
      });
    }
    return loaded;
  }

  /**
   * 热重载：watch 全部已登记根目录，文件/目录变更防抖后按根重扫。
   * 深度根（批 10 工具包）用更大 watch depth——pack 在 level 2，其内容在 level 3+。
   * 返回 stop 函数。daemon 关闭时调用。
   */
  watchRoots(debounceMs = 1000): () => void {
    if (this.watchStop) return this.watchStop;
    const timers = new Map<string, NodeJS.Timeout>();
    const watchers = [...this.roots.entries()].map(([root, meta]) => {
      const w = fsWatch(root, { ignoreInitial: true, depth: meta.deep ? 6 : 2 });
      w.on('all', () => {
        const existing = timers.get(root);
        if (existing) clearTimeout(existing);
        timers.set(
          root,
          setTimeout(() => {
            timers.delete(root);
            const current = this.roots.get(root);
            if (!current) return;
            const scan = current.deep
              ? this.loadToolkitRoot(root, current.scope, current.projectId)
              : this.loadRoot(root, current.scope, current.projectId);
            void scan.catch(() => {});
          }, debounceMs),
        );
      });
      w.on('error', () => {}); // 监听失败不崩 daemon
      return w;
    });
    this.watchStop = () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) void w.close();
      this.watchStop = undefined;
    };
    return this.watchStop;
  }

  /** 重扫全部已登记根（安装/卸载 API 调用；不等热重载防抖窗口）。 */
  async reloadAll(): Promise<void> {
    for (const [root, meta] of [...this.roots]) {
      const scan = meta.deep
        ? this.loadToolkitRoot(root, meta.scope, meta.projectId)
        : this.loadRoot(root, meta.scope, meta.projectId);
      await scan.catch(() => {});
    }
  }

  /** 插件级开关：写 plugin_states 并级联启停其全部规则（保留规则级差异）。 */
  setPluginEnabled(pluginId: string, enabled: boolean): boolean {    const info = this.plugins.get(pluginId);
    if (!info) return false;
    this.deps.states.setEnabled(pluginId, enabled);
    for (const rule of this.deps.rules.listByPlugin(pluginId)) this.deps.rules.setEnabled(rule.id, enabled);
    this.deps.registry.load();
    // rejected 插件即使 enable 也保持 rejected（校验失败不因开关消失）
    const status: LoadedPluginInfo['status'] = enabled
      ? info.error
        ? 'rejected'
        : 'active'
      : 'disabled';
    this.plugins.set(pluginId, { ...info, status });
    this.deps.bus?.emit({ kind: 'plugin.toggled', pluginId, enabled, at: new Date().toISOString() });
    return true;
  }

  private unloadHandlers(pluginId: string): void {
    for (const key of [...this.handlers.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.handlers.delete(key);
    }
    this.subscribers.delete(pluginId);
  }

  /**
   * ⑦ 事件订阅转发：每个采集事件通知全部订阅了该事件的插件。
   * fire-and-forget + 吞错——订阅者慢/挂永不阻塞 ingest 响应路径。
   */
  notifyEvent(eventType: string, payload: unknown, sessionId: string | null): void {
    for (const [pluginId, entry] of this.subscribers) {
      if (!entry.events.has(eventType)) continue;
      const cfg = this.configs.get(pluginId) ?? {};
      void (async () => {
        await entry.sub.onEvent({
          eventType,
          payload,
          sessionId,
          config: cfg,
          logger: createPluginLogger(pluginId),
        });
      })().catch(() => {});
    }
  }

  private emitReload(frame: {
    pluginId: string;
    status: 'active' | 'rejected' | 'disabled';
    ruleCount: number;
    removed?: boolean;
    at?: string;
  }): void {
    this.deps.bus?.emit({ kind: 'plugin.reloaded', at: new Date().toISOString(), ...frame });
  }

  private async loadOne(
    dir: string,
    scope: 'builtin' | 'global' | 'project',
    projectId: number | null,
    dirName: string,
  ): Promise<LoadedPluginInfo> {
    const reject = (id: string, error: string, name = dirName, version = '0.0.0'): LoadedPluginInfo => {
      // 重载失败 = 整体禁用：仅当该 id 上次由本目录注册时，清理其旧规则/handler/
      // 订阅（重复 id 场景 reject 的是别人，绝不能误删已注册插件）。
      const prior = this.plugins.get(id);
      if (prior && prior.dir === dir) {
        this.deps.rules.removeByPlugin(id);
        this.unloadHandlers(id);
        this.configs.delete(id);
      }
      return { id, name, version, dir, scope, projectId, status: 'rejected', error, ruleCount: 0 };
    };

    // 1. manifest 解析与校验
    let manifest: WeavePluginManifest;
    try {
      const raw = JSON.parse(await readFile(path.join(dir, WEAVE_PLUGIN_MANIFEST), 'utf8'));
      const parsed = WeavePluginManifestSchema.safeParse(raw);
      if (!parsed.success) {
        return reject(dirName, `manifest 校验失败: ${parsed.error.issues[0]?.message ?? ''}`);
      }
      manifest = parsed.data;
    } catch (err) {
      return reject(dirName, `manifest 读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. 内置命名空间保留 + 重复 id
    if (scope !== 'builtin' && manifest.id.startsWith('weave-')) {
      return reject(manifest.id, 'id 以 weave- 开头为内置预设命名空间保留', manifest.name, manifest.version);
    }
    const prior = this.plugins.get(manifest.id);
    if (prior && prior.status !== 'rejected' && prior.dir !== dir) {
      return reject(manifest.id, `重复的插件 id（已由 ${prior.dir} 注册）`, manifest.name, manifest.version);
    }

    // 3. requires.events 必须是采集面全集的子集
    const required = manifest.requires?.events ?? [];
    const unknownEvents = required.filter((e) => !(CLAUDE_HOOK_EVENTS as readonly string[]).includes(e));
    if (unknownEvents.length > 0) {
      return reject(manifest.id, `requires.events 含未知事件: ${unknownEvents.join(', ')}`, manifest.name, manifest.version);
    }

    // 4. 规则文件解析（任一条坏 → 整插件 rejected，不做部分注册）
    const entries: unknown[] = [];
    for (const rel of manifest.rules) {
      try {
        const raw = JSON.parse(await readFile(this.resolveWithin(dir, rel), 'utf8'));
        if (!Array.isArray(raw)) throw new Error(`${rel} 不是数组`);
        entries.push(...raw);
      } catch (err) {
        return reject(manifest.id, `规则文件 ${rel}: ${err instanceof Error ? err.message : String(err)}`, manifest.name, manifest.version);
      }
    }

    // 5. handler 入口加载（路径必须留在插件目录内；失败 → 整插件 rejected）
    const pendingHandlers = new Map<string, PluginHandler>();
    for (const h of manifest.handlers) {
      try {
        const entryAbs = this.resolveWithin(dir, h.entry);
        // 查询串破除 ESM 模块缓存，热重载（批 3）时同 URL 不会拿到旧模块。
        const mod = (await import(`${pathToFileURL(entryAbs).href}?t=${Date.now()}`)) as {
          default?: PluginHandler;
        };
        const impl = mod.default;
        if (!impl || typeof impl.execute !== 'function') {
          throw new Error(`${h.entry} 的 default 导出缺少 execute 函数`);
        }
        if (impl.type !== h.type) {
          throw new Error(`${h.entry} 导出 type="${impl.type}" 与 manifest 声明 "${h.type}" 不符`);
        }
        pendingHandlers.set(`${manifest.id}:${h.type}`, impl);
      } catch (err) {
        return reject(manifest.id, `handler ${h.type} 加载失败: ${err instanceof Error ? err.message : String(err)}`, manifest.name, manifest.version);
      }
    }

    // 5b. 事件订阅入口（扩展点⑦）：events 须为采集面子集，entry 导出 onEvent
    let pendingSubscriber: { events: Set<string>; sub: PluginSubscriber } | undefined;
    if (manifest.subscribe) {
      const subEvents = manifest.subscribe.events.filter(
        (e) => !(CLAUDE_HOOK_EVENTS as readonly string[]).includes(e),
      );
      if (subEvents.length > 0) {
        return reject(manifest.id, `subscribe.events 含未知事件: ${subEvents.join(', ')}`, manifest.name, manifest.version);
      }
      try {
        const entryAbs = this.resolveWithin(dir, manifest.subscribe.entry);
        const mod = (await import(`${pathToFileURL(entryAbs).href}?t=${Date.now()}`)) as {
          default?: PluginSubscriber;
        };
        const impl = mod.default;
        if (!impl || typeof impl.onEvent !== 'function') {
          throw new Error(`${manifest.subscribe.entry} 的 default 导出缺少 onEvent 函数`);
        }
        pendingSubscriber = { events: new Set(manifest.subscribe.events), sub: impl };
      } catch (err) {
        return reject(manifest.id, `subscriber 加载失败: ${err instanceof Error ? err.message : String(err)}`, manifest.name, manifest.version);
      }
    }

    // 6. 规则条目校验 + @file: 模板内联 + handler 交叉引用检查
    const rules: HookRule[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      // rules.json 里的 plugin handler 省略 pluginId（由加载器从 manifest 填入）
      const withPluginId =
        typeof entry === 'object' && entry !== null && 'handler' in entry
          ? {
              ...(entry as Record<string, unknown>),
              handler: patchPluginHandler(
                (entry as { handler: unknown }).handler,
                manifest.id,
              ),
            }
          : entry;
      const parsed = PluginRuleEntrySchema.safeParse(withPluginId);
      if (!parsed.success) {
        return reject(manifest.id, `规则 #${i} 校验失败: ${parsed.error.issues[0]?.message ?? ''}`, manifest.name, manifest.version);
      }
      const entry2 = parsed.data;

      let handler = entry2.handler;
      if (handler.type === 'plugin') {
        if (!pendingHandlers.has(`${manifest.id}:${handler.handlerType}`)) {
          return reject(manifest.id, `规则 #${i} 引用未声明的 handler "${handler.handlerType}"`, manifest.name, manifest.version);
        }
      }

      // @file: 模板内联（落库的是展开文本，HookRuleSchema 零改动）
      if ((handler.type === 'inject' || handler.type === 'manual') && handler.template.startsWith(FILE_TEMPLATE_PREFIX)) {
        const rel = handler.template.slice(FILE_TEMPLATE_PREFIX.length);
        try {
          const text = await readFile(this.resolveWithin(dir, rel), 'utf8');
          handler = { ...handler, template: text };
        } catch (err) {
          return reject(manifest.id, `规则 #${i} 模板 ${rel}: ${err instanceof Error ? err.message : String(err)}`, manifest.name, manifest.version);
        }
      }

      let rule: HookRule;
      try {
        rule = HookRuleSchema.parse({
          ...entry2,
          handler,
          id: `plugin:${manifest.id}:${i}`,
          projectId,
          enabled: entry2.enabled ?? true,
          priority: entry2.priority ?? 0,
          origin: scope === 'builtin' ? 'builtin' : 'plugin',
          pluginId: manifest.id,
        });
        validateHandler(rule.source, rule.handler);
      } catch (err) {
        return reject(manifest.id, `规则 #${i}: ${err instanceof Error ? err.message : String(err)}`, manifest.name, manifest.version);
      }
      rules.push(rule);
    }

    // 7. 落库：先 upsert 全部规则（失败回滚该插件规则），再应用插件级开关
    const state = this.deps.states.get(manifest.id);
    try {
      for (const rule of rules) this.deps.rules.upsertPluginRule(rule);
    } catch (err) {
      this.deps.rules.removeByPlugin(manifest.id);
      return reject(manifest.id, `规则入库失败: ${err instanceof Error ? err.message : String(err)}`, manifest.name, manifest.version);
    }
    if (state && !state.enabled) {
      for (const rule of this.deps.rules.listByPlugin(manifest.id)) {
        this.deps.rules.setEnabled(rule.id, false);
      }
    }

    // 8. 接管 handler/config/subscriber（同 id 重载时替换旧实现；
    //    disabled 插件不注册 subscriber——没有规则门槛，必须显式抑制）
    for (const [key, impl] of pendingHandlers) this.handlers.set(key, impl);
    this.configs.set(manifest.id, { ...(manifest.config ?? {}), ...(state?.config ?? {}) });
    if (pendingSubscriber && !(state && !state.enabled)) {
      this.subscribers.set(manifest.id, pendingSubscriber);
    }

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      dir,
      scope,
      projectId,
      status: state && !state.enabled ? 'disabled' : 'active',
      ruleCount: rules.length,
    };
  }

  /** 相对路径解析 + 越界拒绝（entry/规则/模板文件统一走这里防路径穿越）。 */
  private resolveWithin(dir: string, rel: string): string {
    const root = path.resolve(dir);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`路径越出插件目录: ${rel}`);
    }
    return abs;
  }
}

/** rules.json 的 plugin handler 允许省略 pluginId；此处补上（显式给了且不匹配则保留原值让 schema 校验报错）。 */
function patchPluginHandler(handler: unknown, pluginId: string): unknown {
  if (typeof handler !== 'object' || handler === null) return handler;
  const h = handler as Record<string, unknown>;
  if (h.type !== 'plugin' || h.pluginId !== undefined) return handler;
  return { ...h, pluginId };
}

/**
 * SPI 全量加载：工具包扫描根（内置 harness-tools + `add-dir` 外置目录 + M3
 * managed 市场资源根，批 10/装载桥）→ 内置 presets → 全局 `<configDir>/weave/plugins/`
 * → 各注册项目 `<project>/.weave/plugins/`。放在约定位置即被识别（用户决策的接入形态）。
 * 工具包根先注册：浅层 presets 根扫描据此跳过 `harness-tools` 容器目录。
 * 任一根目录失败不抛（loadRoot 内部已吞 readdir 错误）。
 */
export async function loadAllPlugins(
  deps: {
    rules: HookRuleRepository;
    registry: HookRuleRegistry;
    states: PluginStateRepository;
    bus?: HookEventBus;
    /** managed 市场资源（M3 装载桥）；缺省不装载市场根。 */
    libraries?: Pick<LibraryRepository, 'list'>;
  },
  projects: ReadonlyArray<{ id: number; path: string }>,
): Promise<{ loader: WeavePluginLoader; loaded: LoadedPluginInfo[] }> {
  const loader = new WeavePluginLoader(deps);
  const loaded: LoadedPluginInfo[] = [];

  // 批 10：工具包深度根（内置 + 外置 + 市场）——weave 成分走本加载器，天然停用待开关。
  const toolkitSources = await discoverToolkitSources();
  if (deps.libraries) {
    for (const root of marketLibraryRoots(deps.libraries)) {
      toolkitSources.push({ root, provenance: 'market' });
    }
  }
  const seenRoots = new Set<string>(); // 幂等：同根（如市场根同时被 add-dir 注册）只装一次
  for (const source of toolkitSources) {
    const key = path.resolve(source.root);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    loaded.push(
      ...(await loader.loadToolkitRoot(
        source.root,
        source.provenance === 'builtin' ? 'builtin' : 'global',
        null,
      )),
    );
  }

  // 内置预设随 dist 发货（tsc 不拷 JSON，批 2 的 build 脚本负责复制 presets 目录）。
  loaded.push(
    ...(await loader.loadRoot(
      fileURLToPath(new URL('./presets/', import.meta.url)),
      'builtin',
      null,
    )),
  );
  loaded.push(
    ...(await loader.loadRoot(path.join(getDataDir(), 'plugins'), 'global', null)),
  );
  for (const project of projects) {
    loaded.push(
      ...(await loader.loadRoot(
        path.join(project.path, '.weave', 'plugins'),
        'project',
        project.id,
      )),
    );
  }
  return { loader, loaded };
}
