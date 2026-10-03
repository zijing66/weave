import { useT } from '@/i18n/I18nProvider';

/**
 * Renders parsed YAML frontmatter as a structured key/value table — the way
 * Obsidian surfaces a note's properties. Strings/numbers/booleans are shown
 * inline; arrays and nested objects fall back to JSON.
 */
export function FrontmatterCard({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <div className="mb-4 rounded-md border border-white/[0.06] bg-neutral-900/60 p-3">
      <div className="text-xs font-semibold text-neutral-400 uppercase mb-2">
        {t('fm.title')}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-neutral-500">{k}</dt>
            <dd className="font-mono text-neutral-200 break-all">{formatValue(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
