import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import {
  api,
  type ExtensionBindingRow,
  type ExtensionHarnessCapability,
  type ExtensionPoint,
  type SessionRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { errorText } from '@/lib/action-feedback';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Tooltip } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { FieldHint } from '@/components/ui/field-hint';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useBackPop } from '@/lib/back-pop';
import { registerInvalidator } from '@/lib/sse';
import { cn } from '@/lib/utils';
import { sessionLabel } from '@/lib/hook-payload';
import {
  decisionAvailable,
  emptyEndpoint,
  formFromBinding,
  formToInput,
  pointAvailability,
  sessionEndpointAvailable,
  validateForm,
  type BindingFormState,
  type EndpointForm,
} from './binding-model';

/**
 * 会话扩展绑定管理面（批 3）：项目设置内嵌 section（项目模式的 Weave 分类卡里，
 * 与规则面板同区——第三套平级配置面刻意不立）。绑定列表（作用域徽标 / 启停 /
 * 编辑 / 删除走 ConfirmDialog）+ 表单（触发点下拉按派生面置灰并说明原因、
 * when/condition/summarize 三输入、端点列表编辑）+ dry-run 试跑按钮（§1.6
 * 测试台：服务端合成一拍执行，逐阶段回报）。
 */
export function ExtensionBindingsPanel({ projectId }: { projectId: number }) {
  const t = useT();
  const { show } = useToast();
  const [bindings, setBindings] = useState<ExtensionBindingRow[] | null>(null);
  const [caps, setCaps] = useState<ExtensionHarnessCapability[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<BindingFormState | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ExtensionBindingRow | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const refresh = useCallback(() => {
    api
      .listExtensionBindings(projectId)
      .then(setBindings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  useEffect(() => {
    refresh();
    api.extensionCapabilities().then((r) => setCaps(r.harnesses)).catch(() => setCaps(null));
    api
      .listSessions(projectId)
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  }, [refresh, projectId]);

  // 写操作后推 invalidate（同 settings/编排域口径）；接到既有 fetcher 上。
  useEffect(() => registerInvalidator('extensions', refresh), [refresh]);

  // 项目内任何会话行变更（改名/删除）都会影响作用域徽标与会话下拉——轻量重拉。
  useEffect(() => {
    let live = true;
    const id = window.setInterval(() => {
      if (!live || form) return; // 表单开着不抖（下拉候选变了会打断挑选）
      api
        .listSessions(projectId)
        .then((r) => live && setSessions(r.sessions))
        .catch(() => {});
    }, 30_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [projectId, form]);

  // 派生面合并成一行：本项目接入的 harness 逐个取能力；多 harness 时取「都支持」
  // 的交集（有项目行 harness 才看得到面板——v1 不按 harness 分绑定）。
  const cap = useMemo<ExtensionHarnessCapability | null>(() => {
    if (!caps || caps.length === 0) return null;
    // 面板锚项目级：任一 harness 支持即可用（绑定落在项目上，不挑 harness）。
    const merged: ExtensionHarnessCapability = {
      harness: '*',
      points: {
        'turn-end': [...new Set(caps.flatMap((c) => c.points['turn-end'] ?? []))],
        idle: [...new Set(caps.flatMap((c) => c.points.idle ?? []))],
      },
      endpoints: {
        session: caps.some((c) => c.endpoints.session),
        webhook: true,
      },
      decision: caps.some((c) => c.decision),
    };
    return merged;
  }, [caps]);

  const closeForm = (): void => {
    setForm(null);
    setEditingId(null);
    setFormError(null);
  };
  // 移动端返回键/侧滑 = 关闭表单（不确认）
  useBackPop(form != null, () => {
    closeForm();
    return true;
  });

  const openCreate = (): void => {
    setFormError(null);
    setEditingId(null);
    setForm({ ...formFromBindingBase(), sessionId: null });
  };
  const openEdit = (b: ExtensionBindingRow): void => {
    setFormError(null);
    setEditingId(b.id);
    setForm(formFromBinding(b));
  };
  const formFromBindingBase = (): BindingFormState => ({
    name: '',
    sessionId: null,
    point: 'turn-end',
    when: '',
    condition: '',
    summarize: '',
    endpoints: [emptyEndpoint('session')],
    enabled: true,
  });

  const patchForm = (p: Partial<BindingFormState>): void =>
    setForm((f) => (f ? { ...f, ...p } : f));

  const submitForm = async (): Promise<void> => {
    if (!form) return;
    const invalid = validateForm(form);
    if (invalid) {
      setFormError(t(invalid as Parameters<typeof t>[0]));
      return;
    }
    const body = formToInput(form, projectId);
    try {
      if (editingId != null) await api.updateExtensionBinding(editingId, body);
      else await api.createExtensionBinding(body);
      closeForm();
      setError(null);
      refresh();
    } catch (e) {
      setFormError(t('ext.saveFail', { error: errorText(e) }));
    }
  };

  const toggleBinding = async (b: ExtensionBindingRow, enabled: boolean): Promise<void> => {
    try {
      await api.updateExtensionBinding(b.id, { enabled });
      refresh();
    } catch (e) {
      show('error', t('ext.toggleFail', { error: errorText(e) }));
    }
  };

  const deleteBinding = async (): Promise<void> => {
    if (!confirmDelete) return;
    try {
      await api.deleteExtensionBinding(confirmDelete.id);
      setConfirmDelete(null);
      refresh();
    } catch (e) {
      setConfirmDelete(null);
      show('error', t('ext.deleteFail', { error: errorText(e) }));
    }
  };

  const dryRun = async (b: ExtensionBindingRow): Promise<void> => {
    setTestingId(b.id);
    try {
      const r = await api.dryRunExtensionBinding(b.id, {});
      show(
        r.ok ? 'success' : 'info',
        t('ext.testRunDone', { n: r.stages.length }),
      );
    } catch (e) {
      show('error', t('ext.testRunFailed', { error: errorText(e) }));
    } finally {
      setTestingId(null);
    }
  };

  const sessionById = useMemo(
    () => new Map(sessions.map((s) => [s.sessionId, s])),
    [sessions],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight">{t('ext.title')}</h3>
        <FieldHint>{t('ext.hint')}</FieldHint>
        <span className="text-11 text-neutral-500">
          {bindings === null ? t('ext.loading') : t('ext.endpointsCount', { n: bindings.length })}
        </span>
        <button
          type="button"
          onClick={() => (form && editingId === null ? closeForm() : openCreate())}
          className="ml-auto inline-flex items-center gap-1 rounded-lg bg-blue-600/80 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
        >
          {form && editingId === null ? (
            <>
              <X className="h-3.5 w-3.5" />
              {t('ext.cancel')}
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              {t('ext.new')}
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* 绑定列表 */}
      <div className="space-y-2">
        {bindings === null ? (
          <p className="py-2 text-xs text-neutral-500">{t('ext.loading')}</p>
        ) : bindings.length === 0 ? (
          <p className="rounded-xl border border-dashed border-edge/[0.1] bg-neutral-900/40 py-6 text-center text-xs text-neutral-500">
            {t('ext.empty')}
          </p>
        ) : (
          bindings.map((b) => (
            <div
              key={b.id}
              className={cn(
                'rounded-lg border px-3 py-2 transition-colors',
                b.enabled
                  ? 'border-edge/[0.08] bg-neutral-900/40'
                  : 'border-edge/[0.05] bg-neutral-900/20 opacity-70',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
                  {b.name}
                </span>
                <Tooltip label={t('ext.testRunHint')}>
                  <button
                    type="button"
                    disabled={testingId === b.id}
                    onClick={() => void dryRun(b)}
                    className="rounded p-1 text-neutral-500 transition-colors hover:text-blue-300 disabled:opacity-40"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip label={t('ext.edit')}>
                  <button
                    type="button"
                    onClick={() => openEdit(b)}
                    className="rounded p-1 text-neutral-500 transition-colors hover:text-neutral-200"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip label={t('common.delete')}>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(b)}
                    className="rounded p-1 text-neutral-500 transition-colors hover:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Switch
                  checked={b.enabled}
                  onChange={(v) => void toggleBinding(b, v)}
                  title={b.enabled ? t('ext.enabledOn') : t('ext.enabledOff')}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-10 text-neutral-500">
                <Badge variant="skill">{pointKeyLabel(t, b.point)}</Badge>
                <Badge variant="default">
                  {b.sessionId === null
                    ? t('ext.scopeProject')
                    : t('ext.scopeSessionName', {
                        name: sessionLabel(
                          sessionById.get(b.sessionId)?.title ?? null,
                          b.sessionId,
                        ),
                      })}
                </Badge>
                <Badge variant="helper">
                  {t('ext.endpointsCount', { n: b.endpoints.length })}
                </Badge>
                {b.condition?.trim() && <Badge variant="command">{t('ext.field.condition')}</Badge>}
                {b.summarize?.trim() && <Badge variant="command">{t('ext.field.summarize')}</Badge>}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 表单（新建 / 编辑共用）— modal；蒙版不绑 onClick：点击不关闭，防编辑丢失 */}
      {form &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
            <div className="absolute inset-0 bg-black/60" />
            {/* max-h-[85%] 不用 85vh：根 zoom 下视口单位被二次放大（见 index.css #root 注） */}
            <div className="relative flex max-h-[85%] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-edge/[0.08] bg-neutral-900 shadow-mac">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge/[0.06] px-4 py-3">
                <h3 className="truncate text-sm font-semibold text-neutral-200">
                  {editingId != null ? t('ext.form.editTitle') : t('ext.form.createTitle')}
                </h3>
                <Tooltip label={t('ext.cancel')} side="top">
                  <button
                    type="button"
                    onClick={closeForm}
                    className="rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
              <div className="space-y-3 overflow-y-auto px-4 py-3">
                {formError && <p className="text-xs text-red-400">{formError}</p>}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-11 text-neutral-500">{t('ext.field.name')}</span>
                    <Input
                      value={form.name}
                      onChange={(e) => patchForm({ name: e.target.value })}
                      placeholder={t('ext.namePlaceholder')}
                    />
                  </label>

                  <div className="space-y-1">
                    <span className="text-11 text-neutral-500">{t('ext.field.scope')}</span>
                    <Combobox
                      className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
                      value={form.sessionId ?? ''}
                      clearLabel={t('ext.scopeProjectLabel')}
                      options={[
                        ...sessions.map((s) => ({
                          value: s.sessionId,
                          label: sessionLabel(s.title, s.sessionId),
                        })),
                      ]}
                      onChange={(v) => patchForm({ sessionId: v === '' ? null : v })}
                    />
                  </div>

                  <PointField form={form} cap={cap} onChange={(p) => patchForm(p)} />

                  <div className="space-y-1">
                    <span className="text-11 text-neutral-500">{t('ext.field.when')}</span>
                    <Input
                      value={form.when}
                      onChange={(e) => patchForm({ when: e.target.value })}
                      placeholder="done, ok"
                    />
                    <span className="block text-10 text-neutral-600">{t('ext.whenHint')}</span>
                  </div>
                </div>

                <DecisionFields form={form} cap={cap} onChange={(p) => patchForm(p)} />

                <EndpointsField form={form} cap={cap} onChange={(p) => patchForm(p)} sessions={sessions} />

                <label className="inline-flex cursor-pointer items-center gap-1.5 text-11 text-neutral-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-blue-500"
                    checked={form.enabled}
                    onChange={(e) => patchForm({ enabled: e.target.checked })}
                  />
                  {form.enabled ? t('ext.enabledOn') : t('ext.enabledOff')}
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void submitForm()}
                    className="rounded-lg bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
                  >
                    {t('ext.save')}
                  </button>
                  <button
                    type="button"
                    onClick={closeForm}
                    className="rounded-lg border border-edge/[0.08] px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
                  >
                    {t('ext.cancel')}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <ConfirmDialog
        open={confirmDelete != null}
        title={t('ext.deleteTitle')}
        message={
          confirmDelete
            ? t('ext.deleteConfirm', { name: confirmDelete.name })
            : ''
        }
        confirmLabel={t('common.delete')}
        onConfirm={() => void deleteBinding()}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

/** 触发点选择（按派生面置灰 + 原因； Combobox 不可选项以 title 说明）。 */
function PointField({
  form,
  cap,
  onChange,
}: {
  form: BindingFormState;
  cap: ExtensionHarnessCapability | null;
  onChange: (p: Partial<BindingFormState>) => void;
}) {
  const t = useT();
  const points: ExtensionPoint[] = ['turn-end', 'idle'];
  const options = points.map((p) => {
    const a = pointAvailability(cap, p);
    const labelKey =
      p === 'turn-end' ? 'ext.pointTurnEnd' : ('ext.pointIdle' as Parameters<typeof t>[0]);
    return {
      value: p,
      label: `${t(labelKey)}${a.available ? '' : ` · ${t(a.reason!)}`}`,
      hint: a.available
        ? t(p === 'turn-end' ? 'ext.pointTurnEndHint' : 'ext.pointIdleHint', {
            events: a.events.join(', '),
          })
        : undefined,
    };
  });
  const current = pointAvailability(cap, form.point);
  return (
    <div className="space-y-1">
      <span className="text-11 text-neutral-500">{t('ext.field.point')}</span>
      <Combobox
        className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
        value={form.point}
        options={options}
        onChange={(v) => onChange({ point: v as ExtensionPoint })}
        // 当前值不可用（派生面在编辑中途变窄）= 换回第一个可用的，不静默留着
        placeholder={current.available ? undefined : t(current.reason!)}
      />
      {!current.available && (
        <span className="block text-10 text-amber-400/80">{t(current.reason!)}</span>
      )}
    </div>
  );
}

/** 决策两输入（condition / summarize）：无 fork 提取面 = 整块置灰并说明。 */
function DecisionFields({
  form,
  cap,
  onChange,
}: {
  form: BindingFormState;
  cap: ExtensionHarnessCapability | null;
  onChange: (p: Partial<BindingFormState>) => void;
}) {
  const t = useT();
  const d = decisionAvailable(cap);
  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', !d.available && 'opacity-50')}>
      <label className="block space-y-1">
        <span className="text-11 text-neutral-500">{t('ext.field.condition')}</span>
        <Input
          disabled={!d.available}
          value={form.condition}
          onChange={(e) => onChange({ condition: e.target.value })}
        />
        <span className="block text-10 text-neutral-600">{t('ext.conditionHint')}</span>
      </label>
      <label className="block space-y-1">
        <span className="text-11 text-neutral-500">{t('ext.field.summarize')}</span>
        <Input
          disabled={!d.available}
          value={form.summarize}
          onChange={(e) => onChange({ summarize: e.target.value })}
        />
        <span className="block text-10 text-neutral-600">
          {d.available ? t('ext.summarizeHint') : t(d.reason!)}
        </span>
      </label>
    </div>
  );
}

/** 端点列表编辑（session：target + 文案；webhook：url + secret）。 */
function EndpointsField({
  form,
  cap,
  onChange,
  sessions,
}: {
  form: BindingFormState;
  cap: ExtensionHarnessCapability | null;
  onChange: (p: Partial<BindingFormState>) => void;
  sessions: SessionRow[];
}) {
  const t = useT();
  const s = sessionEndpointAvailable(cap);
  const patchEndpoint = (i: number, p: Partial<EndpointForm>): void =>
    onChange({
      endpoints: form.endpoints.map((e, idx) => (idx === i ? { ...e, ...p } : e)),
    });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-11 text-neutral-500">{t('ext.field.endpoints')}</span>
        <span className="block text-10 text-neutral-600">{t('ext.endpointVars')}</span>
      </div>
      {form.endpoints.map((e, i) => (
        <div
          key={i}
          className={cn(
            'space-y-2 rounded-lg border border-edge/[0.06] bg-edge/[0.015] p-2',
            e.kind === 'session' && !s.available && 'opacity-50',
          )}
        >
          <div className="flex items-center gap-2">
            <Combobox
              className="w-40 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
              value={e.kind}
              options={[
                {
                  value: 'session',
                  label: t('ext.endpointKindSession'),
                  hint: s.available ? undefined : t('ext.endpointSessionUnavailable'),
                },
                { value: 'webhook', label: t('ext.endpointKindWebhook') },
              ]}
              onChange={(v) =>
                patchEndpoint(i, { kind: v as EndpointForm['kind'] })
              }
            />
            <button
              type="button"
              title={t('ext.endpointRemove')}
              onClick={() =>
                onChange({ endpoints: form.endpoints.filter((_, idx) => idx !== i) })
              }
              className="ml-auto rounded p-1 text-neutral-500 transition-colors hover:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {e.kind === 'session' ? (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <span className="text-10 text-neutral-600">{t('ext.endpointSessionTarget')}</span>
                  <Combobox
                    className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs"
                    value={e.target}
                    creatable
                    placeholder={t('ext.sessionPickPlaceholder')}
                    options={[
                      { value: 'self', label: t('ext.endpointSelfTarget') },
                      ...sessions
                        .filter((row) => row.sessionId !== form.sessionId || true)
                        .map((row) => ({
                          value: row.sessionId,
                          label: sessionLabel(row.title, row.sessionId),
                        })),
                    ]}
                    onChange={(v) => patchEndpoint(i, { target: v })}
                  />
                </div>
                <label className="block space-y-1">
                  <span className="text-10 text-neutral-600">{t('ext.endpointSessionText')}</span>
                  <Input
                    value={e.text}
                    onChange={(ev) => patchEndpoint(i, { text: ev.target.value })}
                    placeholder="{summary}"
                  />
                </label>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-10 text-neutral-400">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-blue-500"
                  checked={e.oneWay}
                  onChange={(ev) => patchEndpoint(i, { oneWay: ev.target.checked })}
                />
                {t('ext.endpointOneWay')}
              </label>
            </>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-10 text-neutral-600">{t('ext.endpointWebhookUrl')}</span>
                <Input
                  value={e.url}
                  onChange={(ev) => patchEndpoint(i, { url: ev.target.value })}
                  placeholder="https://example.com/hook"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-10 text-neutral-600">{t('ext.endpointWebhookSecret')}</span>
                <Input
                  value={e.secret}
                  onChange={(ev) => patchEndpoint(i, { secret: ev.target.value })}
                />
              </label>
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({ endpoints: [...form.endpoints, emptyEndpoint('webhook')] })
        }
        className="rounded-lg border border-edge/[0.08] px-2.5 py-1.5 text-11 text-neutral-300 transition-colors hover:bg-neutral-800"
      >
        <Plus className="mr-1 inline h-3 w-3" />
        {t('ext.addEndpoint')}
      </button>
    </div>
  );
}

function pointKeyLabel(
  t: ReturnType<typeof useT>,
  point: ExtensionPoint,
): string {
  const key =
    point === 'turn-end'
      ? 'ext.pointTurnEnd'
      : point === 'idle'
        ? 'ext.pointIdle'
        : point === 'tool-failed'
          ? 'ext.pointToolFailed'
          : 'ext.pointSessionEnd';
  return t(key as Parameters<typeof t>[0]);
}
