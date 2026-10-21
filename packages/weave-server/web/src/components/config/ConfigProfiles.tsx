import { useState } from 'react';
import { Copy, Check, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import type { ConfigProfileMeta } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';

/**
 * 本地快照条：把当前文件另存一份、重命名、复制、删除、切换。
 * 切换不在这里直接落盘——先把要覆盖的两侧交给 `onActivate` 走 diff 确认。
 */
export function ConfigProfiles({
  profiles,
  activeId,
  enabled,
  busy,
  onCreate,
  onRename,
  onDuplicate,
  onRemove,
  onSaveActive,
  onActivate,
}: {
  profiles: ConfigProfileMeta[];
  activeId: string | null;
  /** 该档是否支持多份配置（项目档跟着仓库走 → false）。 */
  enabled: boolean;
  busy: boolean;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onSaveActive: () => void;
  onActivate: (id: string) => void;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  if (!enabled) {
    return (
      <section className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3">
        <p className="text-[11px] text-neutral-500">{t('cfg.profileNoSwitch')}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-neutral-300">{t('cfg.profiles')}</span>
        {creating ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={name}
              placeholder={t('cfg.profileNewPlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  onCreate(name.trim());
                  setName('');
                  setCreating(false);
                }
                if (e.key === 'Escape') {
                  setName('');
                  setCreating(false);
                }
              }}
              className="rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-mac-accent/50"
            />
            <button
              disabled={!name.trim()}
              onClick={() => {
                onCreate(name.trim());
                setName('');
                setCreating(false);
              }}
              className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            >
              {t('common.confirm')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-700"
          >
            <Plus className="h-3 w-3" />
            {t('cfg.profileNew')}
          </button>
        )}
        {activeId && (
          <button
            disabled={busy}
            onClick={onSaveActive}
            className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
          >
            <Save className="h-3 w-3" />
            {t('cfg.profileSave')}
          </button>
        )}
      </div>

      {profiles.length === 0 ? (
        <p className="text-[11px] text-neutral-500">{t('cfg.profileEmpty')}</p>
      ) : (
        <ul className="space-y-1">
          {profiles.map((profile) => {
            const active = profile.id === activeId;
            return (
              <li
                key={profile.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2 py-1.5',
                  active
                    ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                    : 'border-edge/[0.06] bg-neutral-900/40',
                )}
              >
                {renamingId === profile.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => {
                      if (renameText.trim()) onRename(profile.id, renameText.trim());
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (renameText.trim()) onRename(profile.id, renameText.trim());
                        setRenamingId(null);
                      }
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="flex-1 rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-0.5 text-xs text-neutral-200 focus:outline-none"
                  />
                ) : (
                  <span className="flex-1 truncate text-xs text-neutral-200">{profile.name}</span>
                )}
                {active && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-300">
                    <Check className="h-3 w-3" />
                    {t('cfg.profileActive')}
                  </span>
                )}
                <span className="text-[10px] text-neutral-600">
                  {profile.updatedAt.slice(0, 10)}
                </span>
                {!active && (
                  <button
                    disabled={busy}
                    onClick={() => onActivate(profile.id)}
                    className="rounded-md bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                  >
                    {t('cfg.profileActivate')}
                  </button>
                )}
                <button
                  onClick={() => {
                    setRenamingId(profile.id);
                    setRenameText(profile.name);
                  }}
                  title={t('cfg.profileName')}
                  className="p-0.5 rounded text-neutral-600 hover:text-neutral-200 hover:bg-neutral-800"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={() => onDuplicate(profile.id)}
                  title={t('cfg.profileDuplicate')}
                  className="p-0.5 rounded text-neutral-600 hover:text-neutral-200 hover:bg-neutral-800"
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  onClick={() => onRemove(profile.id)}
                  title={t('cfg.profileRemove')}
                  className="p-0.5 rounded text-neutral-600 hover:text-red-300 hover:bg-neutral-800"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
