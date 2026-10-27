import { useState } from 'react';
import { Copy, Check, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import type { ConfigProfileMeta } from '@/lib/api';
import { cn } from '@/lib/utils';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import type { ActionState } from '@/lib/action-feedback';
import { useT } from '@/i18n/I18nProvider';

/** 备份 ID → 展示时刻：`2026-10-26-141530` → `2026-10-26 14:15:30`（老格式原样摆）。 */
function backupLabel(id: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : id;
}

/**
 * 配置库（编辑区上方的一块区域）：手动配置 + 自动备份两个 tab。
 * 每一项都能「与当前对比」——对比弹窗里做覆盖（目标→表单）与存入（表单→配置）；
 * 这里不直接写盘，写盘只有顶部「保存」一个口。
 */
export function ConfigVault({
  profiles,
  activeId,
  enabled,
  backups,
  stateOf,
  onCompareProfile,
  onCompareBackup,
  onCompareDisk,
  onSaveInto,
  onCreate,
  onRename,
  onDuplicate,
  onRemove,
}: {
  profiles: ConfigProfileMeta[];
  activeId: string | null;
  /** 该档是否支持多份配置（项目档跟着仓库走 → false）。 */
  enabled: boolean;
  backups: string[];
  /** 按钮三态（loading 转圈 / success 打勾），key 与面板侧 fb.run 一致。 */
  stateOf: (key: string) => ActionState;
  onCompareProfile: (id: string) => void;
  onCompareBackup: (backupId: string) => void;
  onCompareDisk: () => void;
  /** 表单草稿 → 指定配置（null = 另存为新配置）。 */
  onSaveInto: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<'profiles' | 'backups'>('profiles');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  return (
    <section className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-neutral-950/60 border border-edge/[0.06] p-0.5">
          <button
            onClick={() => setTab('profiles')}
            className={cn(
              'rounded-md px-2 py-0.5 text-11',
              tab === 'profiles' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
            )}
          >
            {t('cfg.vaultProfiles')}
            {profiles.length > 0 && <span className="ml-1 text-neutral-600">{profiles.length}</span>}
          </button>
          <button
            onClick={() => setTab('backups')}
            className={cn(
              'rounded-md px-2 py-0.5 text-11',
              tab === 'backups' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
            )}
          >
            {t('cfg.vaultBackups')}
            {backups.length > 0 && <span className="ml-1 text-neutral-600">{backups.length}</span>}
          </button>
        </div>
        {tab === 'profiles' && enabled && (
          <>
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
                  className="rounded-md bg-neutral-800 px-2 py-1 text-11 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                >
                  {t('common.confirm')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-11 text-neutral-200 hover:bg-neutral-700"
              >
                <Plus className="h-3 w-3" />
                {t('cfg.profileNew')}
              </button>
            )}
          </>
        )}
        <button
          onClick={onCompareDisk}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 text-11 text-neutral-200 hover:bg-neutral-700"
        >
          {t('cfg.compareDisk')}
        </button>
      </div>

      {tab === 'profiles' ? (
        !enabled ? (
          <p className="text-11 text-neutral-500">{t('cfg.profileNoSwitch')}</p>
        ) : profiles.length === 0 ? (
          <p className="text-11 text-neutral-500">{t('cfg.profileEmpty')}</p>
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
                    <span className="inline-flex items-center gap-0.5 text-10 text-emerald-300">
                      <Check className="h-3 w-3" />
                      {t('cfg.profileActive')}
                    </span>
                  )}
                  <span className="text-10 text-neutral-600">{profile.updatedAt.slice(0, 10)}</span>
                  <button
                    disabled={stateOf(`cfg-compare:profile:${profile.id}`) === 'loading'}
                    onClick={() => onCompareProfile(profile.id)}
                    className="rounded-md bg-neutral-800 px-2 py-0.5 text-11 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                  >
                    <FeedbackIcon
                      state={stateOf(`cfg-compare:profile:${profile.id}`)}
                      className="h-3 w-3"
                    />
                    {t('cfg.compare')}
                  </button>
                  <button
                    disabled={stateOf(`cfg-saveinto:${profile.id}`) === 'loading'}
                    onClick={() => onSaveInto(profile.id)}
                    title={t('cfg.saveIntoHint')}
                    className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-0.5 text-11 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                  >
                    <FeedbackIcon
                      state={stateOf(`cfg-saveinto:${profile.id}`)}
                      className="h-3 w-3"
                      icon={<Save className="h-3 w-3" />}
                    />
                    {t('cfg.saveInto')}
                  </button>
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
        )
      ) : backups.length === 0 ? (
        <p className="text-11 text-neutral-500">{t('cfg.backupEmpty')}</p>
      ) : (
        <ul className="divide-y divide-edge/[0.04]">
          {backups.map((backupId) => (
            <li key={backupId} className="flex items-center gap-2 px-2 py-1">
              <span className="font-mono text-11 text-neutral-400">{backupLabel(backupId)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  disabled={stateOf(`cfg-compare:backup:${backupId}`) === 'loading'}
                  onClick={() => onCompareBackup(backupId)}
                  className="rounded-md bg-neutral-800 px-2 py-0.5 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
                >
                  <FeedbackIcon
                    state={stateOf(`cfg-compare:backup:${backupId}`)}
                    className="h-3 w-3"
                  />
                  {t('cfg.compare')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
