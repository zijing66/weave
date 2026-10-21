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
  'skillGrid.uninstallGlobalTitle': '卸载全局技能',
  'skillGrid.uninstallGlobalConfirm':
    '从全局技能位删除「{name}」？链接只移除链接本身，副本将递归删除。',
  'skillGrid.uninstallPackTitle': '卸载插件包',
  'skillGrid.uninstallPackConfirm':
    '从 Claude Code 卸载插件包「{key}」？市场副本保留，可随时重装。',
  'skillGrid.packUninstalled': '已卸载插件包：{label}',
  'skillGrid.effective': '已生效：{done} / {total}',
  'skillGrid.effNone': '没有可统计的 skill',
  'skillGrid.effAll': '{n} 个 skill 全部生效',
  'skillGrid.effDisabled': '{n} 个 skill 因所属插件被禁用而未生效',
  'skillGrid.expandAllGroups': '展开全部分组',
  'skillGrid.collapseAllGroups': '折叠全部分组',
  'skillGrid.expandAll': '全部展开',
  'skillGrid.collapseAll': '全部折叠',
  'skillGrid.plugin': '插件',
  // 插件组逐档三态循环（§4 ②推广；循环序随行判据：三档三态 / 仅启用面布尔）
  'skillGrid.enableDefault': '默认',
  'skillGrid.enableOn': '启用',
  'skillGrid.enableOff': '禁用',
  'skillGrid.scopeUser': '全局',
  'skillGrid.scopeProject': '项目',
  'skillGrid.scopeLocal': '仅本人',
  'skillGrid.enableTip': '{scope}：{state}——点击切换',
  'skillGrid.keyTip': '插件所属市场',

  // —— 仓库维度折叠（Skills 与 Plugins 两页同源的一级维度） ——
  'repo.local': '本地',
  'repo.namespaceTip': '该市场下的全部插件',
  'repo.packCount': '{n} 个包',
  'repo.enabledCount': '已启 {done} / {total}',
  'repo.formLink': '链接',
  'repo.formCopy': '副本',
  'repo.formLegend': '链接 / 副本',
  'repo.formTip':
    '「链接」= 生效内容即源文件；「副本」= 建立链接失败后改用的复制。若环境禁用了链接创建，可在「设置 ▸ 系统 ▸ 开发者选项」启用开发者模式后重装',

  // —— FileAssetTree ——
  'fileTree.all': '全部',
  'fileTree.scopeGlobal': '全局',
  'fileTree.scopeProject': '项目',
  'fileTree.title': '资源管理',
  'fileTree.pathsProject': '{dirs} · 根目录',
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

  // —— 资源管理页视图（四 tab 层已去掉：只留「插件包为主」与「查看文件」两个视图；
  //     标签沿用英文原文，与术语纪律一致） ——
  'assetView.packs': 'Plugins',
  'assetView.config': 'Config',
  'assetView.files': 'Files',
  // —— 主视图里的「外部资源」折叠块（不属任何包的技能/MCP） ——
  'category.externalAssets': '外部资源',
  'category.externalAssetsNote': '不在任何插件包内',
  'category.externalAssetsSummary': '技能 {skills} · MCP {mcp}',

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
  'skillGrid.uninstallGlobalTitle': 'Uninstall global skill',
  'skillGrid.uninstallGlobalConfirm':
    'Remove "{name}" from the global skills location? A link only removes the link itself; a copy is deleted recursively.',
  'skillGrid.uninstallPackTitle': 'Uninstall plugin pack',
  'skillGrid.uninstallPackConfirm':
    'Uninstall plugin pack "{key}" from Claude Code? The market copy is kept and it can be reinstalled anytime.',
  'skillGrid.packUninstalled': 'Plugin pack uninstalled: {label}',
  'skillGrid.effective': 'In effect: {done} / {total}',
  'skillGrid.effNone': 'No skills to count',
  'skillGrid.effAll': 'All {n} skills in effect',
  'skillGrid.effDisabled': '{n} skills not in effect because their plugin is disabled',
  'skillGrid.expandAllGroups': 'Expand all groups',
  'skillGrid.collapseAllGroups': 'Collapse all groups',
  'skillGrid.expandAll': 'Expand all',
  'skillGrid.collapseAll': 'Collapse all',
  'skillGrid.plugin': 'Plugin',
  // Per-scope tri-state cycle on plugin groups (§4; cycle order is row-driven)
  'skillGrid.enableDefault': 'Default',
  'skillGrid.enableOn': 'Enabled',
  'skillGrid.enableOff': 'Disabled',
  'skillGrid.scopeUser': 'Global',
  'skillGrid.scopeProject': 'Project',
  'skillGrid.scopeLocal': 'Local only',
  'skillGrid.enableTip': '{scope}: {state} — click to cycle',
  'skillGrid.keyTip': 'Plugin marketplace',

  // —— Repository-dimension grouping (one L1 dimension shared by Skills & Plugins) ——
  'repo.local': 'Local',
  'repo.namespaceTip': 'Every plugin from this marketplace',
  'repo.packCount': '{n} packs',
  'repo.enabledCount': '{done} / {total} enabled',
  'repo.formLink': 'linked',
  'repo.formCopy': 'copied',
  'repo.formLegend': 'linked / copied',
  'repo.formTip':
    'Linked = the source files are what takes effect; copied = creating a link failed and weave fell back to copying. If link creation is disabled in your environment, enable Developer Mode under Settings ▸ System ▸ For developers and reinstall',

  // —— FileAssetTree ——
  'fileTree.all': 'All',
  'fileTree.scopeGlobal': 'Global',
  'fileTree.scopeProject': 'Project',
  'fileTree.title': 'Resource Management',
  'fileTree.pathsProject': '{dirs} · root dir',
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

  // —— Resource-management page views (the four-tab layer is gone: plugin-pack view + read-only files view) ——
  'assetView.packs': 'Plugins',
  'assetView.config': 'Config',
  'assetView.files': 'Files',
  // —— "External" collapsible block in the main view (skills/MCP outside any pack) ——
  'category.externalAssets': 'External',
  'category.externalAssetsNote': 'not part of any plugin pack',
  'category.externalAssetsSummary': 'skills {skills} · MCP {mcp}',

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
