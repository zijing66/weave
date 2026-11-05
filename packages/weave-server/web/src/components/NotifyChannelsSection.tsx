import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { api, type NotifyChannelConfig, type NotifyChannelKind, type NotifyChannelRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { FieldHint } from '@/components/ui/field-hint';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { errorText } from '@/lib/action-feedback';
import type { MessageKey } from '@/i18n/dict';

/**
 * 外发提醒通道（企微/飞书/钉钉/邮件/微信转发）：会话空闲或等待回答时，
 * 除浏览器三腿外推送到这里登记的全部启用通道。凭据随通道配置落库
 * （与编排 webhook 节点 secret 同口径），管理面回显以便重验。
 */

const KINDS: NotifyChannelKind[] = ['wecom', 'feishu', 'dingtalk', 'email', 'serverchan', 'pushplus'];

const KIND_KEY: Record<NotifyChannelKind, MessageKey> = {
  wecom: 'settings.notifyKindWecom',
  feishu: 'settings.notifyKindFeishu',
  dingtalk: 'settings.notifyKindDingtalk',
  email: 'settings.notifyKindEmail',
  serverchan: 'settings.notifyKindServerchan',
  pushplus: 'settings.notifyKindPushplus',
};

interface Draft {
  id?: string;
  kind: NotifyChannelKind;
  name: string;
  config: NotifyChannelConfig;
}

const emptyDraft = (): Draft => ({ kind: 'wecom', name: '', config: {} });

function needs(kind: NotifyChannelKind): Array<keyof NotifyChannelConfig> {
  switch (kind) {
    case 'email':
      return ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'];
    case 'serverchan':
      return ['sendKey'];
    case 'pushplus':
      return ['token'];
    default:
      return ['url', 'secret'];
  }
}

const FIELD_LABEL: Record<string, MessageKey> = {
  url: 'settings.notifyUrl',
  secret: 'settings.notifySecret', // privacy-scan: ignore（i18n key，不是凭据）
  host: 'settings.notifyHost',
  port: 'settings.notifyPort',
  secure: 'settings.notifySecure',
  user: 'settings.notifyUser',
  pass: 'settings.notifyPass',
  from: 'settings.notifyFrom',
  to: 'settings.notifyTo',
  sendKey: 'settings.notifySendKey',
  token: 'settings.notifyToken',
};

export function NotifyChannelsSection() {
  const t = useT();
  const { show } = useToast();
  const [channels, setChannels] = useState<NotifyChannelRow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<NotifyChannelRow | null>(null);

  const load = useCallback(() => {
    api
      .listNotifyChannels()
      .then((r) => setChannels(r.channels))
      .catch((err) => {
        setChannels([]);
        show('error', errorText(err));
      });
  }, [show]);

  useEffect(load, [load]);

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      show('error', t('settings.notifyNameRequired'));
      return;
    }
    setBusy(true);
    try {
      if (draft.id) {
        await api.updateNotifyChannel(draft.id, {
          kind: draft.kind,
          name,
          config: draft.config,
        });
      } else {
        await api.createNotifyChannel({ kind: draft.kind, name, config: draft.config });
      }
      setDraft(null);
      load();
    } catch (err) {
      show('error', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (channel: NotifyChannelRow) => {
    try {
      const { result } = await api.testNotifyChannel(channel.id);
      if (result.ok) show('success', t('settings.notifyTestOk'));
      else show('error', `${t('settings.notifyTestFail')}: ${result.error ?? result.status}`);
    } catch (err) {
      show('error', errorText(err));
    }
  };

  const toggle = async (channel: NotifyChannelRow, enabled: boolean) => {
    setChannels((list) => list?.map((c) => (c.id === channel.id ? { ...c, enabled } : c)) ?? list);
    try {
      await api.updateNotifyChannel(channel.id, { enabled });
    } catch (err) {
      show('error', errorText(err));
      load();
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.deleteNotifyChannel(removing.id);
      setRemoving(null);
      load();
    } catch (err) {
      show('error', errorText(err));
    }
  };

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
        {t('settings.notifyChannels')}
        <FieldHint>{t('settings.notifyChannelsHint')}</FieldHint>
      </label>

      {channels !== null && channels.length === 0 && !draft && (
        <p className="text-11 text-neutral-500">{t('settings.notifyChannelsEmpty')}</p>
      )}

      {channels && channels.length > 0 && (
        <ul className="space-y-1">
          {channels.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-md border border-edge/[0.06] bg-neutral-900/60 px-2 py-1"
            >
              <span className="rounded bg-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400">
                {t(KIND_KEY[c.kind])}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{c.name}</span>
              <Switch checked={c.enabled} onChange={(v) => void toggle(c, v)} title={t('settings.notifyEnabled')} />
              <button
                type="button"
                onClick={() => void test(c)}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                title={t('settings.notifyTest')}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft({ id: c.id, kind: c.kind, name: c.name, config: { ...c.config } })
                }
                className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                title={t('common.edit')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setRemoving(c)}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-300"
                title={t('common.delete')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!draft && (
        <button
          type="button"
          onClick={() => setDraft(emptyDraft())}
          className="inline-flex items-center gap-1 rounded-md border border-edge/[0.08] px-2 py-1 text-11 text-neutral-300 hover:bg-neutral-800"
        >
          <Plus className="h-3 w-3" />
          {t('settings.notifyAdd')}
        </button>
      )}

      {draft && (
        <div className="space-y-2 rounded-md border border-edge/[0.08] bg-neutral-900/60 p-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-11 text-neutral-400">
              {t('settings.notifyKind')}
              <Combobox
                value={draft.kind}
                onChange={(v) =>
                  setDraft((d) => (d ? { ...d, kind: v as NotifyChannelKind, config: {} } : d))
                }
                options={KINDS.map((k) => ({ value: k, label: t(KIND_KEY[k]) }))}
              />
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-11 text-neutral-400">
              {t('settings.notifyName')}
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                placeholder={t('settings.notifyName')}
              />
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {needs(draft.kind).map((field) => (
              <label key={field} className="flex flex-col gap-1 text-11 text-neutral-400">
                {t(FIELD_LABEL[field] ?? 'settings.notifyName')}
                {field === 'secure' ? (
                  <span className="flex h-[26px] items-center">
                    <Switch
                      checked={draft.config.secure ?? true}
                      onChange={(v) =>
                        setDraft((d) => (d ? { ...d, config: { ...d.config, secure: v } } : d))
                      }
                    />
                  </span>
                ) : (
                  <Input
                    type={field === 'port' ? 'number' : field === 'pass' ? 'password' : 'text'}
                    value={String(draft.config[field] ?? '')}
                    onChange={(e) =>
                      setDraft((d) =>
                        d
                          ? {
                              ...d,
                              config: {
                                ...d.config,
                                [field]: field === 'port' ? Number(e.target.value) : e.target.value,
                              },
                            }
                          : d,
                      )
                    }
                    placeholder={field === 'secret' ? t('settings.notifySecretOptional') : undefined}
                  />
                )}
              </label>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md px-2 py-1 text-11 text-neutral-400 hover:bg-neutral-800"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="inline-flex items-center gap-1 rounded-md bg-mac-accent/20 px-2 py-1 text-11 text-mac-accent hover:bg-mac-accent/30 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {t('common.save')}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={t('settings.notifyDelete')}
        message={t('settings.notifyDeleteConfirm')}
        confirmLabel={t('common.delete')}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
