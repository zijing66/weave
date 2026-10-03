/** App 壳、项目列表、skill 详情抽屉的词条（批次 3a 填充）。 */
export const appZh = {
  // —— App 壳 ——
  'app.projectCount': '{n} 个项目',
  'app.settingsTooltip': '设置（默认终端等）',
  'app.resizeLeft': '拖拽调整左侧宽度',
  'app.resizeRight': '拖拽调整右侧宽度',
  'app.resizeTaskHeight': '拖拽调整任务区高度',
  'app.globalTitle': '全局配置',
  'app.globalSubtitle': '机器级 harness 默认模板 · 作用于所有项目',
  'app.updateCountOne': '1 个更新',
  'app.updateCount': '{n} 个更新',
  'app.syncAllTooltip': '立即应用全部 {n} 个过期资产（等同于让自动同步跑一轮）',
  'app.syncAll': '全部同步',
  'app.scopeCoverageTooltip':
    '自动同步（Sync all 相同）覆盖：Skills、MCP，以及 commands / agents / workflows / rules / output-styles 这些单文件资产。本地改过（custom）的条目会跳过，不会被覆盖。',
  'app.scopeCoverageChip': '覆盖 Skills · MCP · 文件资产',
  'app.autoSyncOnTooltip': '自动同步已开启 — daemon 每约 60 秒自动应用过期资产更新；点击改为手动',
  'app.autoSyncOffTooltip':
    '自动同步已关闭 — 过期资产只提示、不自动更新；点击开启（daemon 每约 60 秒自动应用）',
  'app.autoSyncOn': '自动同步 开',
  'app.autoSyncOff': '自动同步 关',
  'app.needProjectAnchor': '需要至少注册一个项目作为全局数据源。',
  'app.selectProject': '请选择一个项目',
  'app.selectProjectForAssets': '请选择一个项目，资产将安装到该项目。',

  // —— 左侧项目列表 ——
  'project.globalConfig': '全局配置',
  'project.globalSubtitle': '机器级 harness 默认模板',
  'project.sectionHeader': '项目',
  'project.noneRegistered': '尚未注册任何项目',
  'project.openInExplorer': '在资源管理器中打开',
  'project.openInTerminal': '在终端中打开',

  // —— skill 详情抽屉 ——
  'skillDetail.readOnly': '只读',
  'skillDetail.plugin': '插件',
  'skillDetail.local': '本地',
  'skillDetail.fileCount': '{n} 个文件',
  'skillDetail.update': '待更新',
  'skillDetail.custom': '自定义',
  'skillDetail.uninstallTitle': '卸载 skill',
  'skillDetail.expandAllDirs': '展开全部目录',
  'skillDetail.collapseAllDirs': '折叠全部目录',
  'skillDetail.expandAll': '全展开',
  'skillDetail.collapseAll': '全折叠',
  'skillDetail.noFiles': '无文件',
  'skillDetail.emptySkillMd': 'SKILL.md 为空',
  'skillDetail.projectScopeHint': '项目级 skill — 位于 {root}/skills/',
  'skillDetail.globalReadOnlyHint': '全局技能（只读）— 项目视图不可修改全局配置',
  'skillDetail.globalPluginHint': '全局插件技能 — {runtime}',
  'skillDetail.globalLocalHint': '全局本地技能 — {runtime}',

  // —— App 自产错误模板 ——
  'errors.installFailed': '安装失败：{error}',
  'errors.mcpInstallFailed': 'MCP 安装失败：{error}',
  'errors.uninstallFailed': '卸载失败：{error}',
  'errors.mcpUninstallFailed': 'MCP 卸载失败：{error}',
  'errors.syncFailed': '同步失败：{error}',
  'errors.updateFailed': '更新失败：{error}',
  'errors.configUpdateFailed': '配置更新失败：{error}',
  'errors.pluginToggleFailed': '插件启用状态更新失败：{error}',
  'errors.openFailed': '打开失败：{error}',
};

export const appEn: Record<keyof typeof appZh, string> = {
  // —— App shell ——
  'app.projectCount': '{n} projects',
  'app.settingsTooltip': 'Settings (default terminal, etc.)',
  'app.resizeLeft': 'Drag to resize the left pane',
  'app.resizeRight': 'Drag to resize the right pane',
  'app.resizeTaskHeight': 'Drag to resize the task area height',
  'app.globalTitle': 'Global config',
  'app.globalSubtitle': 'Machine-level harness default template · applies to all projects',
  'app.updateCountOne': '1 update',
  'app.updateCount': '{n} updates',
  'app.syncAllTooltip': 'Apply all {n} outdated assets now (equivalent to one auto-sync run)',
  'app.syncAll': 'Sync all',
  'app.scopeCoverageTooltip':
    'Auto-sync (same as Sync all) covers: Skills, MCP, and single-file assets such as commands / agents / workflows / rules / output-styles. Locally modified (custom) entries are skipped and never overwritten.',
  'app.scopeCoverageChip': 'Covers Skills · MCP · file assets',
  'app.autoSyncOnTooltip':
    'Auto-sync is ON — the daemon applies outdated asset updates about every 60 seconds; click to switch to manual',
  'app.autoSyncOffTooltip':
    'Auto-sync is OFF — outdated assets are only flagged, not updated; click to enable (the daemon applies them about every 60 seconds)',
  'app.autoSyncOn': 'Auto-sync ON',
  'app.autoSyncOff': 'Auto-sync OFF',
  'app.needProjectAnchor': 'Register at least one project to serve as the global data source.',
  'app.selectProject': 'Select a project',
  'app.selectProjectForAssets': 'Select a project to install assets into.',

  // —— Project sidebar ——
  'project.globalConfig': 'Global config',
  'project.globalSubtitle': 'Machine-level harness default template',
  'project.sectionHeader': 'Projects',
  'project.noneRegistered': 'No projects registered',
  'project.openInExplorer': 'Open in Explorer',
  'project.openInTerminal': 'Open in terminal',

  // —— Skill detail drawer ——
  'skillDetail.readOnly': 'Read-only',
  'skillDetail.plugin': 'Plugin',
  'skillDetail.local': 'Local',
  'skillDetail.fileCount': '{n} files',
  'skillDetail.update': 'update',
  'skillDetail.custom': 'custom',
  'skillDetail.uninstallTitle': 'Uninstall skill',
  'skillDetail.expandAllDirs': 'Expand all folders',
  'skillDetail.collapseAllDirs': 'Collapse all folders',
  'skillDetail.expandAll': 'Expand all',
  'skillDetail.collapseAll': 'Collapse all',
  'skillDetail.noFiles': 'No files',
  'skillDetail.emptySkillMd': 'Empty SKILL.md',
  'skillDetail.projectScopeHint': 'Project-scope skill — lives in {root}/skills/',
  'skillDetail.globalReadOnlyHint':
    'Global skill (read-only) — global config cannot be changed from the project view',
  'skillDetail.globalPluginHint': 'Global plugin skill — {runtime}',
  'skillDetail.globalLocalHint': 'Global skill (local) — {runtime}',

  // —— App-authored error templates ——
  'errors.installFailed': 'Install failed: {error}',
  'errors.mcpInstallFailed': 'MCP install failed: {error}',
  'errors.uninstallFailed': 'Uninstall failed: {error}',
  'errors.mcpUninstallFailed': 'MCP uninstall failed: {error}',
  'errors.syncFailed': 'Sync failed: {error}',
  'errors.updateFailed': 'Update failed: {error}',
  'errors.configUpdateFailed': 'Config update failed: {error}',
  'errors.pluginToggleFailed': 'Plugin toggle failed: {error}',
  'errors.openFailed': 'Open failed: {error}',
};
