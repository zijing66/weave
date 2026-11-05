/**
 * .mcp.json 合并/剥除已迁 `@weavecode/harness`（claude 专属表示法）；此处
 * re-export 保持存量 import 与测试零改动。生成器 generateMcpJson 已随
 * daemon 托管 MCP 退役。
 */
export { mergeMcpJson, stripWeaveMcp } from '@weavecode/harness';
