/**
 * 薄委托：装面链接原语已上迁到 `@weavecode/harness` 的 `shared/install-link.ts`
 * ——harness 侧的全局装面实现（`claude/plugins.ts`）也要用它，原语留在 server
 * 会让 harness 反向依赖 server。此处保留同名导出，使既有消费点与测试零改。
 */
export {
  linkOrCopy,
  removeInstalled,
  installForm,
  type InstallLinkMode,
  type RemoveInstalledResult,
} from '@weavecode/harness';
