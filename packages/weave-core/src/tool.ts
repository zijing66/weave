/**
 * 工具对象模型（docs/plan/tool-object-model.md §2）——抽象部分 = 状态与控制，
 * 表示法（各 harness 的配置文件形态）不在此：server 装配行、harness 各自落盘。
 *
 * 经 `@weavecode/core/tool` subpath 暴露给 web（同 harness.ts 的 web 直引约束：
 * 纯类型零 node 依赖）。首个产消方 = MCP 面（daemon GET /mcp 行装配）。
 */
import type { Harness } from './harness.js';

/**
 * 范围词表——全仓统一（加 harness/类别不得另起同义词）：
 * `user` = 个人全局配置（~/.claude 等）；`project` = 项目内、随仓库共享；
 * `local` = 个人本项目（CC 插件第三档；MCP/skill 面暂无此档）。
 */
export type ToolScope = 'user' | 'project' | 'local';

/** 工具类别闭表（安装/启停面按类别 × harness 声明）。 */
export type ToolCategory =
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'toolkit'
  | 'command'
  | 'agent'
  | 'workflow'
  | 'rule'
  | 'output-style';

/**
 * 启停覆写三态：`on`/`off` 显式改写；`inherit` = 未覆写、逐上层回落
 * （插件链 local > project > user；MCP 面无链，只项目档有覆写）。
 */
export type EnableOverride = 'on' | 'off' | 'inherit';

/** 单档安装态（跨档独立求值：user 已装、project 未装 ≠ 冲突）。 */
export type InstallState = 'absent' | 'installed' | 'updateAvailable';

/**
 * 单 harness × scope 的工具状态行：扁平一行一个落点，安装与启停的抽象面。
 * 同名多档 = 多行（启停继承链由服务端解析成 `effective`，行上不留链式状态）。
 */
export interface ToolStateRow<D = unknown> {
  /** 工具标识：插件 = `<name>@<marketplace>`；其余类别 = 资产名。 */
  key: string;
  category: ToolCategory;
  harness: Harness;
  scope: ToolScope;
  /** 该 harness 此类别的全部可装范围（安装控制与视图选择用，行行携带）。 */
  installScopes: readonly ToolScope[];
  /** 本面安装态（行存在 = 本面在 installScopes 内；缺省 = 该面无安装语义）。 */
  install?: InstallState;
  /** 该档的启停覆写；null = 此面无启停语义（装了即生效）。 */
  enable: EnableOverride | null;
  /** 服务端唯一解析的生效态（前端不得自算）。 */
  effective: boolean;
  /** 类别专属载荷（MCP = 服务器配置；插件 = 市场身份等）。 */
  detail?: D;
}
