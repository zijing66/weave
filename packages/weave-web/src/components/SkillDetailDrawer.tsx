import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  X,
  FileText,
  FileCode,
  Trash2,
  Folder,
  Globe,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronsDownUp,
} from 'lucide-react';
import {
  api,
  type AssetAgent,
  type AssetEntry,
  type AssetChangeEvent,
  type AssetScope,
  type GlobalSkillSource,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { splitFrontmatter } from '@/lib/markdown';
import { FrontmatterCard } from '@/components/FrontmatterCard';

type FileNode = { type: 'file'; file: AssetEntry };
type DirNode = { type: 'dir'; name: string; path: string; children: TreeNode[] };
type TreeNode = FileNode | DirNode;

const SKILL_PREFIX_RE = /^\.claude\/skills\/[^/]+\//;

function lastSegment(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? relPath : relPath.slice(i + 1);
}

/** Build a sorted file tree from flat asset entries. Directories come before
 * files at every level; SKILL.md sorts first among files; the rest
 * alphabetically. Each directory carries its path (relative to the skill root)
 * as a stable collapse key. */
function buildFileTree(files: AssetEntry[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const rel = file.relPath.replace(SKILL_PREFIX_RE, '');
    const parts = rel.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        node.children.push({ type: 'file', file });
      } else {
        let dir = node.children.find((c): c is DirNode => c.type === 'dir' && c.name === part);
        if (!dir) {
          dir = { type: 'dir', name: part, path: acc, children: [] };
          node.children.push(dir);
        }
        node = dir;
      }
    }
  }
  const sort = (dir: DirNode) => {
    dir.children.sort((a, b) => {
      const aDir = a.type === 'dir';
      const bDir = b.type === 'dir';
      if (aDir !== bDir) return aDir ? -1 : 1;
      if (a.type === 'file' && b.type === 'file') {
        const aMd = a.file.relPath.endsWith('/SKILL.md') ? 0 : 1;
        const bMd = b.file.relPath.endsWith('/SKILL.md') ? 0 : 1;
        if (aMd !== bMd) return aMd - bMd;
      }
      const aName = a.type === 'file' ? lastSegment(a.file.relPath) : a.name;
      const bName = b.type === 'file' ? lastSegment(b.file.relPath) : b.name;
      return aName.localeCompare(bName);
    });
    dir.children.forEach((c) => {
      if (c.type === 'dir') sort(c);
    });
  };
  sort(root);
  return root.children;
}

/** Recursive renderer for the file tree. Directories collapse by path key;
 * files select into the preview pane. */
function FileTreeNode({
  node,
  depth,
  selectedRel,
  onSelect,
  collapsed,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selectedRel: string | undefined;
  onSelect: (f: AssetEntry) => void;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
  const pad = 8 + depth * 12;
  if (node.type === 'file') {
    const active = selectedRel === node.file.relPath;
    const isMd = node.file.relPath.endsWith('/SKILL.md');
    return (
      <button
        onClick={() => onSelect(node.file)}
        style={{ paddingLeft: pad }}
        className={cn(
          'w-full flex items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs font-mono truncate',
          active
            ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50',
        )}
        title={node.file.absPath}
      >
        {isMd ? (
          <FileText className="h-3 w-3 shrink-0 text-blue-400" />
        ) : (
          <FileCode className="h-3 w-3 shrink-0 text-neutral-500" />
        )}
        <span className="truncate">{lastSegment(node.file.relPath)}</span>
      </button>
    );
  }
  const isCollapsed = collapsed.has(node.path);
  return (
    <div>
      <button
        onClick={() => onToggle(node.path)}
        style={{ paddingLeft: pad }}
        className="w-full flex items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800/50"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
        <Folder className="h-3 w-3 shrink-0 text-neutral-500" />
        <span className="truncate">{node.name}</span>
      </button>
      {!isCollapsed &&
        node.children.map((c) => (
          <FileTreeNode
            key={c.type === 'dir' ? c.path : c.file.relPath}
            node={c}
            depth={depth + 1}
            selectedRel={selectedRel}
            onSelect={onSelect}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

/**
 * Right-side drawer showing one installed skill's full detail: scope, file
 * count, status badges, a file list and a live preview of the selected file
 * (SKILL.md renders as markdown + frontmatter; other files as plain text).
 */
export function SkillDetailDrawer({
  projectId,
  name,
  scope,
  source,
  pluginKey,
  agent,
  files,
  readOnly,
  outdated,
  custom,
  onUninstall,
  onClose,
}: {
  projectId: number;
  name: string;
  scope: AssetScope;
  /** Global-skill origin (required to fetch global files). */
  source?: GlobalSkillSource;
  /** `plugin@marketplace` for plugin-sourced global skills. */
  pluginKey?: string;
  /** Runtime surface of a project-scope skill (drives the footer hint). */
  agent?: AssetAgent;
  /** Project-scope asset entries (files inside the project skill directory).
   * Global rows ignore this and fetch via listGlobalSkillFiles. */
  files: AssetEntry[];
  /** Read-only context (a global skill opened from the project view): no
   * uninstall — global config is not changed from a project. */
  readOnly?: boolean;
  outdated: boolean;
  custom: boolean;
  onUninstall: () => void;
  onClose: () => void;
}) {
  const isGlobal = scope === 'global' && !!source;
  // Global rows start with no files and fetch them (follows symlinks).
  const [fileList, setFileList] = useState<AssetEntry[]>(files);
  const [selected, setSelected] = useState<AssetEntry | null>(() => {
    const skillMd = files.find((f) => f.relPath.endsWith('/SKILL.md'));
    return skillMd ?? files[0] ?? null;
  });
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the live watcher when the open file changes on disk.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Keeps the watcher's match target current without re-subscribing.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const tree = useMemo(() => buildFileTree(fileList), [fileList]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  // Every directory path in the tree — used by expand/collapse-all.
  const allDirPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'dir') {
          out.push(n.path);
          walk(n.children);
        }
      }
    };
    walk(tree);
    return out;
  }, [tree]);
  const anyCollapsed = collapsed.size > 0;
  /** One button that flips between expand-all and collapse-all. */
  const toggleAll = () =>
    anyCollapsed ? setCollapsed(new Set()) : setCollapsed(new Set(allDirPaths));

  // Fetch the global skill's file list (symlinks resolved server-side), then
  // default-select SKILL.md. Project rows already have their files passed in.
  useEffect(() => {
    if (!isGlobal) return;
    let cancelled = false;
    api
      .listGlobalSkillFiles(projectId, { source: source!, name, pluginKey })
      .then((list) => {
        if (cancelled) return;
        setFileList(list);
        const md = list.find((f) => f.relPath.endsWith('/SKILL.md'));
        setSelected((prev) => prev ?? md ?? list[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, isGlobal, source, name, pluginKey]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setContent(null);
    setError(null);
    const req =
      isGlobal
        ? api.readGlobalSkillFile(projectId, {
            source: source!,
            name,
            pluginKey,
            path: selected.relPath,
          })
        : api.readFile(projectId, selected.relPath);
    req
      .then((f) => {
        if (!cancelled) setContent(f.content);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, isGlobal, source, name, pluginKey, selected, refreshNonce]);

  // Live watch (global only): the daemon watches the personal skill roots
  // (following symlinks), so edits to a symlinked skill's ORIGINAL files push
  // events here. A match on the open file's absPath re-fetches the preview.
  useEffect(() => {
    if (!isGlobal) return;
    const es = new EventSource(api.eventsUrl());
    es.onmessage = (ev) => {
      try {
        const change = JSON.parse(ev.data) as AssetChangeEvent;
        const sel = selectedRef.current;
        if (sel && change.absPath === sel.absPath) setRefreshNonce((n) => n + 1);
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => es.close();
  }, [isGlobal]);

  const isMarkdown = selected?.relPath.toLowerCase().endsWith('.md') ?? false;
  const parsed = content != null && isMarkdown ? splitFrontmatter(content) : null;
  const isPlugin = source?.endsWith('-plugin') ?? false;
  const runtimeLabel = source?.startsWith('codex') ? 'Codex' : 'Claude';

  return (
    <div className="absolute right-0 top-0 h-full w-[min(720px,88%)] z-30 flex flex-col frosted-strong border-l border-white/[0.08] shadow-mac">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-white/[0.06]">
        <FileCode className="h-4 w-4 shrink-0 text-blue-400" />
        <span className="text-sm font-semibold truncate">{name}</span>
        {scope === 'project' ? (
          <Badge variant="default">project</Badge>
        ) : (
          <>
            <Badge variant="skill">global</Badge>
            {readOnly && <Badge variant="settings">只读</Badge>}
          </>
        )}
        {isGlobal && (
          <>
            <Badge variant={isPlugin ? 'mcp' : 'skill'}>
              {isPlugin ? '插件' : '本地'}
            </Badge>
            <Badge variant="other">{runtimeLabel}</Badge>
          </>
        )}
        <Badge>{fileList.length} files</Badge>
        {outdated && <Badge variant="warning">update</Badge>}
        {custom && <Badge variant="other">custom</Badge>}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {!readOnly && (
            <button
              onClick={onUninstall}
              className="text-neutral-500 hover:text-red-400"
              title="Uninstall skill"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body: file list + preview */}
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 shrink-0 border-r border-white/[0.06] overflow-y-auto p-2 space-y-0.5">
          {tree.length > 0 && (
            <div className="flex items-center gap-1 pb-1.5 mb-1 border-b border-white/[0.06]">
              <button
                onClick={toggleAll}
                className="inline-flex items-center gap-1 rounded-full bg-neutral-800 text-neutral-400 px-1.5 py-0.5 text-[10px] hover:bg-neutral-700"
                title={anyCollapsed ? '展开全部目录' : '折叠全部目录'}
              >
                {anyCollapsed ? (
                  <ChevronsUpDown className="h-2.5 w-2.5" />
                ) : (
                  <ChevronsDownUp className="h-2.5 w-2.5" />
                )}
                {anyCollapsed ? '全展开' : '全折叠'}
              </button>
            </div>
          )}
          {tree.length === 0 && (
            <p className="text-xs text-neutral-600">
              {isGlobal ? 'Loading…' : 'No files'}
            </p>
          )}
          {tree.map((node) => (
            <FileTreeNode
              key={node.type === 'dir' ? node.path : node.file.relPath}
              node={node}
              depth={0}
              selectedRel={selected?.relPath}
              onSelect={setSelected}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))}
        </aside>

        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="text-red-400 text-xs">{error}</p>}
          {content == null && !error && (
            <p className="text-xs text-neutral-500">Loading…</p>
          )}
          {parsed && (
            <>
              {parsed.frontmatter && <FrontmatterCard data={parsed.frontmatter} />}
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {parsed.body}
                </ReactMarkdown>
              </div>
            </>
          )}
          {content != null && !isMarkdown && (
            <pre className="text-xs font-mono text-neutral-300 whitespace-pre-wrap break-all bg-neutral-900 rounded-md p-3 border border-white/[0.06]">
              {content}
            </pre>
          )}
          {selected?.relPath.endsWith('/SKILL.md') && content === '' && (
            <p className="text-xs text-neutral-600">Empty SKILL.md</p>
          )}
        </div>
      </div>

      {/* Footer hint */}
      <div className="flex items-center gap-2 p-2 border-t border-white/[0.06] text-[11px] text-neutral-500">
        {scope === 'project' ? (
          <>
            <Folder className="h-3 w-3" />
            Project-scope skill — lives in {agent === 'codex' ? '.codex' : '.claude'}/skills/
          </>
        ) : readOnly ? (
          <>
            <Globe className="h-3 w-3" />
            全局技能（只读）— 项目视图不可修改全局配置
          </>
        ) : isPlugin ? (
          <>
            <Globe className="h-3 w-3" />
            全局插件技能 — {runtimeLabel}
          </>
        ) : (
          <>
            <Globe className="h-3 w-3" />
            全局本地技能 — {runtimeLabel}
          </>
        )}
      </div>
    </div>
  );
}
