/** skill 网格、资源管理文件树、MCP、分类栏等词条（批次 3d 填充）。 */
export const assetsZh = {
  // —— SkillGrid ——
  'skillGrid.projectHeading': '项目 Skills',
  'skillGrid.globalHeading': '全局 Skills',
  'skillGrid.readOnly': '只读',
  'skillGrid.globalTag': '全局',
  'skillGrid.update': '待更新',
  'skillGrid.custom': '自定义',
  'skillGrid.openDetail': '打开 {name} 详情',
  'skillGrid.uninstall': '卸载 {name}',
  'skillGrid.uninstalled': '已卸载：{name}',
  'skillGrid.effective': '已生效：{done} / {total}',
  'skillGrid.effNone': '没有可统计的 skill',
  'skillGrid.effAll': '{n} 个 skill 全部生效',
  'skillGrid.effDisabled': '{n} 个 skill 因所属插件被禁用而未生效',
  'skillGrid.expandAllGroups': '展开全部分组',
  'skillGrid.collapseAllGroups': '折叠全部分组',
  'skillGrid.expandAll': '全部展开',
  'skillGrid.collapseAll': '全部折叠',
  'skillGrid.plugin': '插件',
  'skillGrid.pluginOn': '已启用 — 点击切换',
  'skillGrid.pluginOff': '已禁用 — 点击切换',
  'skillGrid.on': '开',
  'skillGrid.off': '关',
  'skillGrid.keyTip': '插件注册键 name@marketplace——@后为所属市场（插件 namespace）',

  // —— 仓库维度折叠（Skills 与 Plugins 两页同源的一级维度） ——
  'repo.local': '本地',
  'repo.namespaceTip': '仓库 namespace：该市场下所有插件都归这一块',
  'repo.packCount': '{n} 个包',
  'repo.formLink': '链接',
  'repo.formCopy': '副本',
  'repo.formLegend': '链接 / 副本',
  'repo.formTip':
    'weave 装在全局位置时的形态：链接 = 该处不存副本（改源即改生效）；副本 = 建立链接失败已回退复制。Windows 的目录链接用 junction、通常无需开发者模式——若你的环境禁用了链接创建，可在「设置 ▸ 系统 ▸ 开发者选项」启用开发者模式后重装',

  // —— FileAssetTree ——
  'fileTree.all': '全部',
  'fileTree.scopeGlobal': '全局',
  'fileTree.scopeProject': '项目',
  'fileTree.title': '资源管理',
  'fileTree.pathsGlobal': '~/.claude/ · ~/.codex/',
  'fileTree.pathsProject': '.claude/ · .codex/ · 根目录',
  'fileTree.expandAllDirs': '展开全部目录',
  'fileTree.collapseAllDirs': '折叠全部目录',
  'fileTree.expandAll': '全展开',
  'fileTree.collapseAll': '全折叠',
  'fileTree.emptyFiltered': '没有匹配当前筛选的文件',
  'fileTree.symlinkTitle': '{path} — 符号链接',
  'fileTree.uninstall': '卸载 {name}',
  'fileTree.uninstalled': '已卸载：{name}',
  'fileTree.update': '待更新',
  'fileTree.custom': '自定义',

  // —— 资源管理页 AssetTab（标签用英文原文，与术语纪律一致） ——
  'assetTab.files': 'Files',
  'assetTab.skills': 'Skills',
  'assetTab.mcp': 'MCP',
  'assetTab.plugins': 'Plugins',

  // —— McpGrid ——
  'mcp.headingGlobal': '全局 MCP Servers',
  'mcp.headingProject': '项目 MCP Servers',
  'mcp.update': '待更新',
  'mcp.remove': '移除 {name}',
  'mcp.uninstalled': '已卸载：{name}',
  'mcp.enableDefault': '默认',
  'mcp.enableOn': '启用',
  'mcp.enableOff': '禁用',
  'mcp.enableTip': '{state} — 点击切换',
  'mcp.enableFailed': 'MCP 启用状态切换失败：{error}',

  // —— CategoryBar ——
  'catbar.files': '资源管理',
  'catbar.personalization': '个性化配置',
  'catbar.updateBadge': '{n} 待更新',
  'catbar.custom': '自定义',
  'catbar.followGlobal': '跟随全局',
  'catbar.items': '{n} 项',

  // —— TaskView ——
  'task.heading': '任务（{events} 条事件，{sessions} 个会话）',
  'task.expandAll': '全部展开',
  'task.collapseAll': '全部折叠',
  'task.empty': '暂无 hook 事件',
  'task.events': '{n} 条事件',
  'task.noPayload': '无 payload 详情',
  'task.copySessionId': '复制会话 ID',
  'task.copied': '已复制',
  'task.pendingTitle': '待生效',

  // —— FileViewer / FrontmatterCard ——
  'fm.title': 'Frontmatter',
};

export const assetsEn: Record<keyof typeof assetsZh, string> = {
  // —— SkillGrid ——
  'skillGrid.projectHeading': 'Project Skills',
  'skillGrid.globalHeading': 'Global Skills',
  'skillGrid.readOnly': 'Read-only',
  'skillGrid.globalTag': 'Global',
  'skillGrid.update': 'update',
  'skillGrid.custom': 'custom',
  'skillGrid.openDetail': 'Open {name} detail',
  'skillGrid.uninstall': 'Uninstall {name}',
  'skillGrid.uninstalled': 'Uninstalled: {name}',
  'skillGrid.effective': 'In effect: {done} / {total}',
  'skillGrid.effNone': 'No skills to count',
  'skillGrid.effAll': 'All {n} skills in effect',
  'skillGrid.effDisabled': '{n} skills not in effect because their plugin is disabled',
  'skillGrid.expandAllGroups': 'Expand all groups',
  'skillGrid.collapseAllGroups': 'Collapse all groups',
  'skillGrid.expandAll': 'Expand all',
  'skillGrid.collapseAll': 'Collapse all',
  'skillGrid.plugin': 'Plugin',
  'skillGrid.pluginOn': 'Enabled — click to toggle',
  'skillGrid.pluginOff': 'Disabled — click to toggle',
  'skillGrid.on': 'ON',
  'skillGrid.off': 'OFF',
  'skillGrid.keyTip': 'Plugin key name@marketplace — the part after @ is its marketplace (plugin namespace)',

  // —— Repository-dimension grouping (one L1 dimension shared by Skills & Plugins) ——
  'repo.local': 'Local',
  'repo.namespaceTip': 'Repository namespace: every plugin from this marketplace groups here',
  'repo.packCount': '{n} packs',
  'repo.formLink': 'linked',
  'repo.formCopy': 'copied',
  'repo.formLegend': 'linked / copied',
  'repo.formTip':
    'How weave laid it down at the global location: linked = no copy lives there (edits to the source take effect); copied = creating a link failed and weave fell back to copying. Directory links on Windows use junctions and normally need no Developer Mode — if link creation is disabled in your environment, enable Developer Mode under Settings ▸ System ▸ For developers and reinstall',

  // —— FileAssetTree ——
  'fileTree.all': 'All',
  'fileTree.scopeGlobal': 'Global',
  'fileTree.scopeProject': 'Project',
  'fileTree.title': 'Resource Management',
  'fileTree.pathsGlobal': '~/.claude/ · ~/.codex/',
  'fileTree.pathsProject': '.claude/ · .codex/ · root dir',
  'fileTree.expandAllDirs': 'Expand all folders',
  'fileTree.collapseAllDirs': 'Collapse all folders',
  'fileTree.expandAll': 'Expand all',
  'fileTree.collapseAll': 'Collapse all',
  'fileTree.emptyFiltered': 'No files match the current filter',
  'fileTree.symlinkTitle': '{path} — symlink',
  'fileTree.uninstall': 'Uninstall {name}',
  'fileTree.uninstalled': 'Uninstalled: {name}',
  'fileTree.update': 'update',
  'fileTree.custom': 'custom',

  // —— AssetTab on the resource management page (labels stay English terms) ——
  'assetTab.files': 'Files',
  'assetTab.skills': 'Skills',
  'assetTab.mcp': 'MCP',
  'assetTab.plugins': 'Plugins',

  // —— McpGrid ——
  'mcp.headingGlobal': 'Global MCP Servers',
  'mcp.headingProject': 'Project MCP Servers',
  'mcp.update': 'update',
  'mcp.remove': 'Remove {name}',
  'mcp.uninstalled': 'Uninstalled: {name}',
  'mcp.enableDefault': 'Default',
  'mcp.enableOn': 'Enabled',
  'mcp.enableOff': 'Disabled',
  'mcp.enableTip': '{state} — click to cycle',
  'mcp.enableFailed': 'MCP enable state toggle failed: {error}',

  // —— CategoryBar ——
  'catbar.files': 'Resource Management',
  'catbar.personalization': 'Personalization',
  'catbar.updateBadge': '{n} update',
  'catbar.custom': 'Custom',
  'catbar.followGlobal': 'Follow global',
  'catbar.items': '{n} items',

  // —— TaskView ——
  'task.heading': 'Tasks ({events} events, {sessions} sessions)',
  'task.expandAll': 'Expand all',
  'task.collapseAll': 'Collapse all',
  'task.empty': 'No hook events yet',
  'task.events': '{n} events',
  'task.noPayload': 'No payload details',
  'task.copySessionId': 'Copy session ID',
  'task.copied': 'Copied',
  'task.pendingTitle': 'Pending',

  // —— FileViewer / FrontmatterCard ——
  'fm.title': 'Frontmatter',
};
