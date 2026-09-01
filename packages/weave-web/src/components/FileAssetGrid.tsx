import {
  type AssetAgent,
  type AssetEntry,
  type FileAssetCategory,
  type FileAssetUpdate,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Trash2, FileCode } from 'lucide-react';

export const FILE_ASSET_META: Record<
  FileAssetCategory,
  { label: string; dir: string }
> = {
  command: { label: 'Commands', dir: '.claude/commands' },
  agent: { label: 'Agents', dir: '.claude/agents' },
  workflow: { label: 'Workflows', dir: '.claude/workflows' },
  rule: { label: 'Rules', dir: '.claude/rules' },
  'output-style': { label: 'Output Styles', dir: '.claude/output-styles' },
};

/** Row model for one installed single-file asset. */
export interface FileAssetRow {
  name: string;
  category: FileAssetCategory;
  relPath: string;
}

/** Map asset entries of the given categories to rows (name = file stem). */
export function toFileAssetRows(
  assets: AssetEntry[],
  categories: FileAssetCategory[],
): FileAssetRow[] {
  const rows: FileAssetRow[] = [];
  for (const a of assets) {
    if (!categories.includes(a.category as FileAssetCategory)) continue;
    const posix = a.relPath.replace(/\\/g, '/');
    const name = posix.split('/').pop() ?? posix;
    const stem = name.replace(/\.(md|js)$/u, '');
    rows.push({ name: stem, category: a.category as FileAssetCategory, relPath: a.relPath });
  }
  return rows.sort((x, y) => x.name.localeCompare(y.name));
}

function FileAssetCard({
  row,
  update,
  onUninstall,
  onOpenFile,
}: {
  row: FileAssetRow;
  update: FileAssetUpdate | undefined;
  onUninstall: (row: FileAssetRow) => void;
  onOpenFile: (relPath: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="items-center gap-2">
        <button
          onClick={() => onOpenFile(row.relPath)}
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          title={`Open ${row.relPath}`}
        >
          <FileCode className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <CardTitle className="truncate">{row.name}</CardTitle>
          {update?.outdated && (
            <Badge variant="warning" className="ml-1">
              update
            </Badge>
          )}
          {update?.custom && (
            <Badge variant="other" className="ml-1">
              custom
            </Badge>
          )}
        </button>
        <button
          onClick={() => onUninstall(row)}
          className="text-neutral-500 hover:text-red-400 shrink-0"
          title={`Uninstall ${row.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </CardHeader>
    </Card>
  );
}

/** Grid of installed single-file assets for one category. */
export function FileAssetGrid({
  category,
  rows,
  updates,
  onUninstall,
  onOpenFile,
}: {
  category: FileAssetCategory;
  rows: FileAssetRow[];
  updates?: FileAssetUpdate[];
  onUninstall: (row: FileAssetRow) => void;
  onOpenFile: (relPath: string) => void;
}) {
  const meta = FILE_ASSET_META[category];
  if (!rows.length) {
    return (
      <section className="space-y-2">
        <h2 className="text-xs font-semibold text-neutral-400 uppercase">
          {meta.label} <span className="text-neutral-600 normal-case font-normal">{meta.dir}</span>
        </h2>
        <p className="text-xs text-neutral-600 border border-dashed border-white/[0.06] rounded-md p-3">
          暂无 {meta.label.toLowerCase()}
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-neutral-400 uppercase">
        {meta.label} ({rows.length}){' '}
        <span className="text-neutral-600 normal-case font-normal">{meta.dir}</span>
      </h2>
      <div className="grid grid-cols-2 gap-3 items-start">
        {rows.map((r) => (
          <FileAssetCard
            key={r.relPath}
            row={r}
            update={updates?.find((u) => u.name === r.name && u.category === r.category)}
            onUninstall={onUninstall}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </section>
  );
}

/** Uninstall payload for a file asset row. */
export function fileAssetInstallBody(
  row: FileAssetRow,
  agent?: AssetAgent,
): { category: FileAssetCategory; name: string; agent?: AssetAgent } {
  return { category: row.category, name: row.name, ...(agent ? { agent } : {}) };
}
