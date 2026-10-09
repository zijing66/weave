/** 工具包区段词条（批 10）。 */
export const toolkitZh = {
  'toolkit.title': '工具箱',
  'toolkit.hint': '内置 · 外置目录 · 市场导入共用同一条扫描管线；CC 插件与 mod 整包装，其余按包成分启停',
  'toolkit.groupClaude': 'Claude Plugins',
  'toolkit.groupPacks': '表面工具包',
  'toolkit.claudeGroupHint':
    'Claude Code 原生插件与 mod——仅 claude harness 生效，codex 运行态隐藏',
  'toolkit.empty': '暂无工具包',
  'toolkit.loading': '加载中…',
  'toolkit.loadFailed': '加载失败：{error}',
  'toolkit.toggleFailed': '操作失败：{error}',
  'toolkit.uninstallFailed': '卸载失败：{error}',
  'toolkit.uninstalled': '已卸载：{name}',
  'toolkit.legacyCleaned': '已清理旧副本',
  'toolkit.toggleTip': '启用/停用本项目（CC 插件与 mod 首次启用会先安装到全局）',
  'toolkit.kind.skill': 'skill',
  'toolkit.kind.hook': 'hook',
  'toolkit.kind.mod': 'mod',
  'toolkit.kind.rule': 'rule',
  'toolkit.kind.surface': 'surface',
  'toolkit.prov.builtin': '内置',
  'toolkit.prov.external-dir': '外置目录',
  'toolkit.prov.market': '市场',
  'toolkit.targets': '目标：{targets}',
  'toolkit.weaveRules': '规则 {n}',
  'toolkit.keyTip':
    'CC 注册键 name@marketplace——@后为所属市场（插件 namespace）；安装 scope：{scopes}',
  'toolkit.scopesNone': '未安装',
  'toolkit.legacyTitle': '发现 {n} 个 Weave 旧插件副本',
  'toolkit.legacyHint': '旧管线复制进项目插件位的死数据（Claude Code 不加载），可安全清理',
  'toolkit.legacyCleanup': '清理',
  'toolkit.dirsTitle': '外置目录',
  'toolkit.dirsEmpty': '未注册外置目录',
  'toolkit.dirsHint':
    '本地文件夹注册为扫描源，与内置 · 市场同一管线。增删经 REST 端点 POST /toolkit/dirs 与 /toolkit/dirs/remove 完成（移除时级联卸载已启用包）。',
  'toolkit.uninstall': '卸载',
  'toolkit.uninstallTip':
    '从 harness 彻底卸载（CC 插件与 mod 执行 claude plugin uninstall；表面包清扫已复制文件；预置源保留可重装）',
};

export const toolkitEn: Record<keyof typeof toolkitZh, string> = {
  'toolkit.title': 'Toolkit',
  'toolkit.hint':
    'Builtin, external dirs and market imports share one scan pipeline; CC plugins & mods install as a whole, others toggle by component',
  'toolkit.groupClaude': 'Claude Plugins',
  'toolkit.groupPacks': 'Surface packs',
  'toolkit.claudeGroupHint':
    'Claude Code native plugins and mods — effective only on the claude harness; hidden under the codex runtime',
  'toolkit.empty': 'No toolkit packs',
  'toolkit.loading': 'Loading…',
  'toolkit.loadFailed': 'Load failed: {error}',
  'toolkit.toggleFailed': 'Operation failed: {error}',
  'toolkit.uninstallFailed': 'Uninstall failed: {error}',
  'toolkit.uninstalled': 'Uninstalled: {name}',
  'toolkit.legacyCleaned': 'Stale copies cleaned up',
  'toolkit.toggleTip':
    'Enable/disable in this project (CC plugins & mods install globally on first enable)',
  'toolkit.kind.skill': 'skill',
  'toolkit.kind.hook': 'hook',
  'toolkit.kind.mod': 'mod',
  'toolkit.kind.rule': 'rule',
  'toolkit.kind.surface': 'surface',
  'toolkit.prov.builtin': 'builtin',
  'toolkit.prov.external-dir': 'external',
  'toolkit.prov.market': 'market',
  'toolkit.targets': 'Targets: {targets}',
  'toolkit.weaveRules': 'rules {n}',
  'toolkit.keyTip':
    'CC plugin key name@marketplace — the part after @ is its marketplace (plugin namespace); install scope: {scopes}',
  'toolkit.scopesNone': 'not installed',
  'toolkit.legacyTitle': 'Found {n} stale Weave plugin copies',
  'toolkit.legacyHint':
    'Dead data the old pipeline copied into the project plugin dir (Claude Code does not load it); safe to clean up',
  'toolkit.legacyCleanup': 'Clean up',
  'toolkit.dirsTitle': 'External dirs',
  'toolkit.dirsEmpty': 'No external dirs registered',
  'toolkit.dirsHint':
    'Local folders registered as scan sources — same pipeline as builtin and market. Add/remove via the REST endpoints `POST /toolkit/dirs` and `/toolkit/dirs/remove` (removal cascade-uninstalls enabled packs)',
  'toolkit.uninstall': 'Uninstall',
  'toolkit.uninstallTip':
    'Uninstall from the harness (CC plugins & mods run claude plugin uninstall; surface packs clean copied files; shipped sources stay and can be reinstalled)',
};
