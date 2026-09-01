import { useState } from 'react';
import { type AssetEntry } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

/** command / agent are rendered by FileAssetGrid; here only the tail kinds. */
const CATEGORY_ORDER = ['helper', 'settings', 'other'];

function groupByCategory(assets: AssetEntry[]): Map<string, AssetEntry[]> {
  const m = new Map<string, AssetEntry[]>();
  for (const a of assets) {
    const list = m.get(a.category) ?? [];
    list.push(a);
    m.set(a.category, list);
  }
  for (const list of m.values()) list.sort((x, y) => x.relPath.localeCompare(y.relPath));
  return m;
}

export function OtherAssets({
  assets,
  onOpenFile,
}: {
  assets: AssetEntry[];
  onOpenFile: (relPath: string) => void;
}) {
  const groups = groupByCategory(assets);
  const cats = CATEGORY_ORDER.filter((c) => groups.has(c));
  if (!cats.length) return null;
  return (
    <div className="space-y-2">
      {cats.map((cat) => (
        <Group key={cat} category={cat} items={groups.get(cat)!} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function Group({
  category,
  items,
  onOpenFile,
}: {
  category: string;
  items: AssetEntry[];
  onOpenFile: (relPath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 mb-1">
        <span className="text-xs w-3">{open ? '▾' : '▸'}</span>
        <Badge variant={category}>{category}</Badge>
        <span className="text-xs text-neutral-500">({items.length})</span>
      </button>
      {open && (
        <ul className="ml-4 space-y-0.5">
          {items.map((a) => (
            <li key={a.relPath}>
              <button
                onClick={() => onOpenFile(a.relPath)}
                className="block w-full text-left text-xs font-mono text-neutral-400 hover:text-neutral-200 truncate"
                title={a.absPath}
              >
                {a.relPath}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
