import { useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { api, type RpgRoleView } from '@/lib/api';
import { Input } from '@/components/ui/input';

/**
 * 建角色表单（E4 验收④）：角色创建入口在游戏视图内，不绕资源管理——
 * 名字 + 七型 archetype + 可选人设，走既有 `POST /rpg/roles`（落
 * `<data>/rpg/roles/`，服务端校验 kebab-case）。名字校验沿服务端既有口径
 * （ROLE_NAME_RE），本面只做同一正则的前置提示。
 */

const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ARCHETYPES = ['能量', '思考', '创造', '连接', '审核', '执行', '适配'] as const;

export function CreateRoleForm({ onCreated }: { onCreated: (role: RpgRoleView) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [archetype, setArchetype] = useState<(typeof ARCHETYPES)[number]>('适配');
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = ROLE_NAME_RE.test(name.trim());
  const submit = async (): Promise<void> => {
    if (!nameOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const role = await api.createRole({
        name: name.trim(),
        archetype,
        ...(persona.trim() ? { persona: persona.trim() } : {}),
      });
      onCreated(role);
      setName('');
      setPersona('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('rpg.roleNamePlaceholder')}
          className="w-56"
          aria-label={t('rpg.roleNamePlaceholder')}
        />
        <div className="flex flex-wrap gap-1">
          {ARCHETYPES.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setArchetype(a)}
              className={
                'rounded px-2 py-1 text-xs ' +
                (a === archetype
                  ? 'bg-[var(--w-accent)] text-white'
                  : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]')
              }
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        placeholder={t('rpg.rolePersonaPlaceholder')}
        rows={3}
        className="w-full rounded-md border border-edge/[0.08] bg-neutral-900 p-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-mac-accent/50 focus:outline-none"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!nameOk || busy}
          onClick={() => void submit()}
          className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? '…' : t('rpg.roleCreate')}
        </button>
        {!nameOk && name.trim() !== '' && (
          <span className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.roleNameInvalid')}</span>
        )}
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    </div>
  );
}
