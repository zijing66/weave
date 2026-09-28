import { useEffect, useState, type ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  api,
  type LibraryRow,
  type SkillAsset,
  type McpTemplate,
  type McpServerConfig,
  type AssetScope,
  type AssetAgent,
  type FileAssetTemplate,
  type FileAssetCategory,
  type UpdateReport,
  FILE_ASSET_CATEGORIES,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { DirectoryPickerModal } from '@/components/DirectoryPickerModal';
import { cn } from '@/lib/utils';
import { type MainCategory } from '@/components/CategoryBar';
import {
  GripVertical,
  Trash2,
  Server,
  Globe,
  Folder,
  FolderOpen,
  FileCode,
  RefreshCw,
  PackageX,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronsDownUp,
} from 'lucide-react';

interface LibraryPanelProps {
  /** Skill names already installed in the selected project (for the ✓ mark). */
  installedSkillNames: Set<string>;
  /** Click-to-install fallback (drag is the primary interaction). */
  onInstallSkill: (skill: SkillAsset, scope: AssetScope, agent: AssetAgent) => void;
  onInstallFileAsset: (file: FileAssetTemplate, scope: AssetScope) => void;
  onInstallMcp: (name: string, config: McpServerConfig, scope: AssetScope, agent?: AssetAgent) => void;
  updates: UpdateReport | null;
  onUpdateAsset: (
    category: 'skill' | 'mcp' | FileAssetCategory,
    name: string,
    scope: AssetScope,
    agent?: AssetAgent,
  ) => void;
  /** Which main category is active — the panel shows matching installable lists. */
  category: MainCategory;
  /** Install-to scope, driven by the current project/global context. */
  scope: AssetScope;
}

export function LibraryPanel({
  installedSkillNames,
  onInstallSkill,
  onInstallFileAsset,
  onInstallMcp,
  updates,
  onUpdateAsset,
  category,
  scope,
}: LibraryPanelProps) {
  const [libraries, setLibraries] = useState<LibraryRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [skills, setSkills] = useState<SkillAsset[]>([]);
  const [fileTemplates, setFileTemplates] = useState<FileAssetTemplate[]>([]);
  const [mcp, setMcp] = useState<McpTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Install-to runtime for skills and MCP (Claude vs Codex surfaces). */
  const [installAgent, setInstallAgent] = useState<AssetAgent>('claude');

  useEffect(() => {
    api.listLibraries().then(setLibraries).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setSkills([]);
      setFileTemplates([]);
      setMcp([]);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .listLibraryAssets(selectedId)
      .then((r) => {
        setSkills(r.skills);
        setFileTemplates(r.files ?? []);
        setMcp(r.mcp ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedId]);

  /** Add every picked folder as a library (invoked by the directory picker
   * modal; paths arrive pre-validated). */
  async function handlePicked(paths: string[]) {
    for (const p of paths) {
      try {
        const lib = await api.addLibrary(p, 'skill');
        setLibraries((prev) => [lib, ...prev.filter((l) => l.path !== lib.path)]);
        setSelectedId(lib.id);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  function removeLibrary(id: number) {
    api
      .removeLibrary(id)
      .then(() => {
        setLibraries((prev) => prev.filter((l) => l.id !== id));
        if (selectedId === id) setSelectedId(null);
      })
      .catch((e) => setError(String(e)));
  }

  // Per-group (skills/ directory) collapse in the Skill templates list.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Section-level collapse (Skill templates / MCP templates / Update hints).
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) =>
    setSectionsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const outdatedSkills = (updates?.skills ?? []).filter((u) => u.outdated);
  const outdatedMcp = (updates?.mcp ?? []).filter((u) => u.outdated);
  const outdatedFiles = (updates?.files ?? []).filter((u) => u.outdated);

  // The installable list shown depends on the active main category.
  const showSkills = category === 'skills';
  const showFiles = category === 'commands';
  const showMcp = category === 'mcp';
  const noTemplates = !showSkills && !showMcp && !showFiles;

  // Sections and groups that are currently rendered — collapse-all targets.
  const visibleSections = [
    ...(showSkills ? [SECTION_SKILLS] : []),
    ...(showFiles ? [SECTION_FILES] : []),
    ...(showMcp ? [SECTION_MCP] : []),
    ...(outdatedSkills.length > 0 || outdatedMcp.length > 0 || outdatedFiles.length > 0
      ? [SECTION_UPDATES]
      : []),
  ];
  const groupKeys = groupSkills(skills).map(([g]) => g || '__root__');
  const anyCollapsed =
    visibleSections.some((k) => sectionsCollapsed.has(k)) ||
    groupKeys.some((k) => collapsedGroups.has(k));
  /** One button that flips between expand-all and collapse-all. */
  function toggleAll() {
    if (anyCollapsed) {
      setSectionsCollapsed(new Set());
      setCollapsedGroups(new Set());
    } else {
      setSectionsCollapsed(new Set(visibleSections));
      setCollapsedGroups(new Set(groupKeys));
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-white/[0.06] space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-neutral-400 uppercase">Asset Libraries</h2>
          {!noTemplates && (
            <button
              onClick={toggleAll}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-1.5 py-0.5 text-[10px] hover:bg-neutral-700"
              title={anyCollapsed ? '展开全部分组与区块' : '折叠全部分组与区块'}
            >
              {anyCollapsed ? (
                <ChevronsUpDown className="h-2.5 w-2.5" />
              ) : (
                <ChevronsDownUp className="h-2.5 w-2.5" />
              )}
              {anyCollapsed ? '全展开' : '全折叠'}
            </button>
          )}
        </div>

        {/* Install-to context (follows the active project/global selection) */}
        <div className="rounded-md border border-white/[0.06] bg-neutral-900/60 p-2 flex items-center gap-2">
          {scope === 'global' ? (
            <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          )}
          <span className="text-[11px] text-neutral-400">
            Install to{' '}
            <span className={cn('font-semibold', scope === 'global' ? 'text-emerald-300' : 'text-blue-300')}>
              {scope === 'global' ? 'Global' : 'Project'}
            </span>
          </span>
          <span className="ml-auto text-[11px] text-neutral-600">跟随当前选择</span>
        </div>

        {/* Add libraries via the in-browser cross-platform directory picker */}
        <button
          onClick={() => setPickerOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 rounded bg-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-700"
          title="选择一个或多个文件夹作为资产库"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          添加文件夹（可多选）
        </button>
        <DirectoryPickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onConfirm={(paths) => {
            setPickerOpen(false);
            void handlePicked(paths);
          }}
          existingPaths={libraries.map((l) => l.path)}
        />
        {libraries.length > 0 && (
          <ul className="space-y-0.5">
            {libraries.map((lib) => (
              <li key={lib.id} className="flex items-center gap-1">
                <button
                  onClick={() => setSelectedId(lib.id)}
                  className={cn(
                    'flex-1 min-w-0 text-left text-xs truncate rounded px-1.5 py-1',
                    selectedId === lib.id ? 'bg-neutral-800' : 'hover:bg-neutral-900',
                  )}
                  title={lib.path}
                >
                  {lib.path}
                </button>
                <button
                  onClick={() => removeLibrary(lib.id)}
                  className="text-neutral-500 hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-red-400 text-xs px-3 py-1">{error}</p>}

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {noTemplates && (
          <div className="rounded-md border border-dashed border-white/[0.08] bg-neutral-900/40 p-4 text-center">
            <PackageX className="h-5 w-5 mx-auto text-neutral-600 mb-1" />
            <p className="text-xs text-neutral-500">
              「{categoryLabel(category)}」分类暂无外部可安装模板。
            </p>
            <p className="text-[11px] text-neutral-600 mt-0.5">
              切换到 Skills / MCP 分类查看可安装内容。
            </p>
          </div>
        )}

        {/* Skill templates — grouped by their parent skills/ directory */}
        {showSkills && (
          <TemplateSection
            icon={<FileCode className="h-3.5 w-3.5 text-emerald-400" />}
            title="Skill templates"
            hint="Drag to install"
            count={skills.length}
            open={!sectionsCollapsed.has(SECTION_SKILLS)}
            onToggle={() => toggleSection(SECTION_SKILLS)}
          >
            {loading && <p className="text-xs text-neutral-500">Scanning…</p>}
            {!loading && selectedId === null && (
              <p className="text-xs text-neutral-600">Add a library above to browse skills.</p>
            )}
            {!loading && selectedId !== null && skills.length === 0 && (
              <p className="text-xs text-neutral-600">No skills found.</p>
            )}
            {/* Install-to runtime: Claude (.claude/skills) or Codex (.codex/skills) */}
            <AgentToggle
              agent={installAgent}
              onChange={setInstallAgent}
              kind="skills"
              globalHint={scope === 'global'}
            />
            {groupSkills(skills).map(([group, items]) => {
              const key = group || '__root__';
              const collapsed = collapsedGroups.has(key);
              return (
                <div key={key} className="mb-1">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(key);
                      }
                    }}
                    className="flex items-center gap-1 text-[11px] text-neutral-600 font-mono mb-0.5 cursor-pointer select-none hover:text-neutral-400 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                    title={group || 'library root'}
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    <Folder className="h-3 w-3 shrink-0 text-emerald-500/60" />
                    <span className="truncate">{group || 'library root'}</span>
                    <Badge variant="skill" className="shrink-0">
                      本地
                    </Badge>
                    <Badge className="shrink-0">{items.length}</Badge>
                  </div>
                  {!collapsed && (
                    <div className="space-y-0.5">
                      {items.map((s) => (
                        <DraggableSkill
                          key={s.name}
                          skill={s}
                          agent={installAgent}
                          installed={installedSkillNames.has(s.name)}
                          onInstall={() => onInstallSkill(s, scope, installAgent)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </TemplateSection>
        )}

        {/* File templates — commands / agents / workflows / rules / output-styles */}
        {showFiles && (
          <TemplateSection
            icon={<FileCode className="h-3.5 w-3.5 text-blue-400" />}
            title="File templates"
            hint="Click to install"
            count={fileTemplates.length}
            open={!sectionsCollapsed.has(SECTION_FILES)}
            onToggle={() => toggleSection(SECTION_FILES)}
          >
            {loading && <p className="text-xs text-neutral-500">Scanning…</p>}
            {!loading && selectedId === null && (
              <p className="text-xs text-neutral-600">Add a library above to browse templates.</p>
            )}
            {!loading && selectedId !== null && fileTemplates.length === 0 && (
              <p className="text-xs text-neutral-600">
                库中未发现文件模板（commands / agents / workflows / rules / output-styles 目录）。
              </p>
            )}
            {FILE_ASSET_CATEGORIES.map((cat) => {
              const items = fileTemplates.filter((f) => f.category === cat);
              if (!items.length) return null;
              return (
                <div key={cat} className="mb-1">
                  <div className="flex items-center gap-1 text-[11px] text-neutral-600 font-mono mb-0.5">
                    <Folder className="h-3 w-3 shrink-0 text-emerald-500/60" />
                    <span className="truncate">{cat}</span>
                    <Badge className="shrink-0">{items.length}</Badge>
                  </div>
                  <div className="space-y-0.5">
                    {items.map((f) => (
                      <div
                        key={f.filePath}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-900"
                        title={f.filePath}
                      >
                        <FileCode className="h-3 w-3 shrink-0 text-blue-400" />
                        <span className="truncate">{f.name}</span>
                        <button
                          onClick={() => onInstallFileAsset(f, scope)}
                          className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                        >
                          install
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </TemplateSection>
        )}

        {/* MCP templates */}
        {showMcp && (
          <TemplateSection
            icon={<Server className="h-3.5 w-3.5 text-blue-400" />}
            title="MCP templates"
            hint="Click to add"
            count={mcp.length}
            open={!sectionsCollapsed.has(SECTION_MCP)}
            onToggle={() => toggleSection(SECTION_MCP)}
          >
            {mcp.length === 0 && (
              <p className="text-xs text-neutral-600">No MCP templates found.</p>
            )}
            {/* Install-to runtime: Claude (.mcp.json / ~/.claude.json) or Codex (~/.codex/config.toml) */}
            <AgentToggle agent={installAgent} onChange={setInstallAgent} kind="mcp" />
            {mcp.map((t) => (
              <div
                key={t.name}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-900"
                title={t.sourcePath}
              >
                <Server className="h-3 w-3 shrink-0 text-blue-400" />
                <span className="truncate">{t.name}</span>
                <button
                  onClick={() =>
                    onInstallMcp(
                      t.name,
                      {
                        command: t.command,
                        ...(t.args && { args: t.args }),
                        ...(t.env && { env: t.env }),
                      },
                      scope,
                      installAgent,
                    )
                  }
                  className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                >
                  install
                </button>
              </div>
            ))}
          </TemplateSection>
        )}

        {/* Update hints */}
        {(outdatedSkills.length > 0 || outdatedMcp.length > 0 || outdatedFiles.length > 0) && (
          <TemplateSection
            icon={<RefreshCw className="h-3.5 w-3.5 text-orange-400" />}
            title="Update hints"
            hint="Overwrites local changes"
            count={outdatedSkills.length + outdatedMcp.length + outdatedFiles.length}
            open={!sectionsCollapsed.has(SECTION_UPDATES)}
            onToggle={() => toggleSection(SECTION_UPDATES)}
          >
            {outdatedSkills.map((u) => (
              <UpdateHintRow
                key={`skill-${u.agent ?? 'claude'}-${u.scope}-${u.name}`}
                label={u.name}
                scope={u.scope}
                agent={u.agent}
                onUpdate={() => onUpdateAsset('skill', u.name, u.scope, u.agent)}
              />
            ))}
            {outdatedFiles.map((u) => (
              <UpdateHintRow
                key={`file-${u.category}-${u.name}`}
                label={`${u.category}/${u.name}`}
                scope={u.scope}
                onUpdate={() => onUpdateAsset(u.category, u.name, u.scope)}
              />
            ))}
            {outdatedMcp.map((u) => (
              <UpdateHintRow
                key={`mcp-${u.agent ?? 'claude'}-${u.scope}-${u.name}`}
                label={u.name}
                scope={u.scope}
                agent={u.agent}
                onUpdate={() => onUpdateAsset('mcp', u.name, u.scope, u.agent)}
              />
            ))}
          </TemplateSection>
        )}
      </div>

      {showMcp && (
        <McpForm
          onInstall={(name, config) => onInstallMcp(name, config, scope, installAgent)}
        />
      )}
    </div>
  );
}

function categoryLabel(category: MainCategory): string {
  switch (category) {
    case 'skills':
      return 'Skills';
    case 'mcp':
      return 'MCP';
    case 'commands':
      return 'Commands';
    case 'personalization':
      return '个性化配置';
  }
}

/** Collapse-state keys for the template sections. */
const SECTION_SKILLS = 'skill-templates';
const SECTION_FILES = 'file-templates';
const SECTION_MCP = 'mcp-templates';
const SECTION_UPDATES = 'update-hints';

/**
 * Group skills by their parent `skills/` directory so a library with multiple
 * folders (e.g. `lib/coding/skills/review` + `lib/writing/skills/docs`) shows
 * each skills directory as a headed block with its peers as a row. Empty group
 * (skill directly under the library root) sorts last.
 */
function groupSkills(skills: SkillAsset[]): [string, SkillAsset[]][] {
  const m = new Map<string, SkillAsset[]>();
  for (const s of skills) {
    const list = m.get(s.group) ?? [];
    list.push(s);
    m.set(s.group, list);
  }
  return [...m.entries()].sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    return a[0].localeCompare(b[0]);
  });
}

/** Claude / Codex install-target toggle shared by the skill and MCP template
 * sections. Tooltips and the destination hint differ per kind. */
function AgentToggle({
  agent,
  onChange,
  kind,
  globalHint,
}: {
  agent: AssetAgent;
  onChange: (a: AssetAgent) => void;
  kind: 'skills' | 'mcp';
  /** skills only: show the ~/.codex path hint in global scope. */
  globalHint?: boolean;
}) {
  const tips =
    kind === 'skills'
      ? {
          claude: '安装到 .claude/skills/',
          codex: '安装到 .codex/skills/（全局则为 ~/.codex/skills/）',
        }
      : {
          claude: '安装到 .mcp.json / ~/.claude.json',
          codex: '写入 ~/.codex/config.toml（全局，增量合并）',
        };
  return (
    <div className="flex items-center gap-1 mb-1">
      <span className="text-[11px] text-neutral-500 shrink-0">安装目标</span>
      {(['claude', 'codex'] as const).map((a) => (
        <button
          key={a}
          onClick={() => onChange(a)}
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px]',
            agent === a
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-300',
          )}
          title={tips[a]}
        >
          {a === 'claude' ? 'Claude' : 'Codex'}
        </button>
      ))}
      {agent === 'codex' && (
        <span className="text-[10px] text-neutral-600">
          {kind === 'skills'
            ? globalHint
              ? '→ ~/.codex/skills/'
              : '→ .codex/skills/'
            : '→ ~/.codex/config.toml（全局）'}
        </span>
      )}
    </div>
  );
}

function TemplateSection({
  icon,
  title,
  hint,
  count,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  /** Item count shown as a tag (stays visible when collapsed). */
  count?: number;
  /** Controlled collapse state (lifted so expand/collapse-all can drive it). */
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex items-center gap-1.5 mb-1.5 cursor-pointer select-none rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
        title={open ? '折叠' : '展开'}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 text-neutral-500" />
        )}
        {icon}
        <span className="text-xs font-semibold text-neutral-300">{title}</span>
        {count !== undefined && <Badge variant="other">{count}</Badge>}
        <span className="text-[11px] text-neutral-500 ml-auto">{hint}</span>
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </section>
  );
}

function UpdateHintRow({
  label,
  scope,
  agent,
  onUpdate,
}: {
  label: string;
  scope: AssetScope;
  agent?: AssetAgent;
  onUpdate: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-900">
      <RefreshCw className="h-3 w-3 shrink-0 text-orange-400" />
      <span className="truncate">{label}</span>
      {agent === 'codex' && (
        <Badge variant="other" className="shrink-0">
          Codex
        </Badge>
      )}
      <Badge variant="skill" className="shrink-0">
        {scope}
      </Badge>
      <button
        onClick={onUpdate}
        className="ml-auto text-xs text-blue-400 hover:text-blue-300 shrink-0"
      >
        update
      </button>
    </div>
  );
}

function DraggableSkill({
  skill,
  agent,
  installed,
  onInstall,
}: {
  skill: SkillAsset;
  /** Install target carried through the drag payload. */
  agent: AssetAgent;
  installed: boolean;
  onInstall: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `lib-skill-${skill.name}`,
    data: { sourceDir: skill.dirPath, name: skill.name, agent },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-grab transition-colors duration-200',
        isDragging && 'opacity-40',
        'hover:bg-neutral-800/50',
      )}
      title={skill.dirPath}
    >
      <GripVertical className="h-3 w-3 shrink-0 text-neutral-600" />
      <span className="truncate">{skill.name}</span>
      {installed ? (
        <Badge variant="skill" className="ml-auto">
          installed
        </Badge>
      ) : (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onInstall();
          }}
          className="ml-auto text-xs text-blue-400 hover:text-blue-300"
        >
          install
        </button>
      )}
    </div>
  );
}

function McpForm({
  onInstall,
}: {
  onInstall: (name: string, config: McpServerConfig) => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');

  function submit() {
    if (!name.trim() || !command.trim()) return;
    const argList = args.trim() ? args.trim().split(/\s+/) : undefined;
    const envMap = parseEnv(env);
    onInstall(name.trim(), {
      command: command.trim(),
      ...(argList && { args: argList }),
      ...(envMap && { env: envMap }),
    });
    setName('');
    setCommand('');
    setArgs('');
    setEnv('');
  }

  return (
    <div className="border-t border-white/[0.06] p-3 space-y-1.5">
      <h3 className="text-xs font-semibold text-neutral-400 uppercase flex items-center gap-1">
        <Server className="h-3 w-3" /> Add MCP Server
      </h3>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="command (e.g. npx)"
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <input
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        placeholder="args (space-separated)"
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <textarea
        value={env}
        onChange={(e) => setEnv(e.target.value)}
        placeholder="env (KEY=value per line)"
        rows={2}
        className="w-full bg-neutral-900 rounded px-2 py-1 text-xs font-mono"
      />
      <button
        onClick={submit}
        disabled={!name.trim() || !command.trim()}
        className="w-full rounded bg-blue-900/40 text-blue-300 py-1 text-xs disabled:opacity-40"
      >
        Add MCP Server
      </button>
    </div>
  );
}

function parseEnv(text: string): Record<string, string> | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const obj: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i > 0) obj[line.slice(0, i)] = line.slice(i + 1);
  }
  return Object.keys(obj).length ? obj : undefined;
}
