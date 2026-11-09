import { useCallback, useEffect, useState } from 'react';
import { Globe, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, type DiscoveredPeer, type PeerRow } from '@/lib/api';
import { useI18n } from '@/i18n/I18nProvider';
import { registerInvalidator } from '@/lib/sse';
import { Switch } from '@/components/ui/switch';
import { FieldHint } from '@/components/ui/field-hint';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { errorText } from '@/lib/action-feedback';

/** 在线态派生（与 server 的 peerLiveness 同判据）：90s 内有心跳 = online。 */
const OFFLINE_AFTER_MS = 90_000;
function livenessOf(lastSeenAt: string | null): 'online' | 'offline' | 'never-seen' {
  if (!lastSeenAt) return 'never-seen';
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return 'never-seen';
  return Date.now() - at <= OFFLINE_AFTER_MS ? 'online' : 'offline';
}

/**
 * 联邦管理面（F1）：两个开关（联邦 / mDNS 发现）+ 已配对 peer 列表（在线态 +
 * 手动添加 + 删除即吊销 token）+ 双向 pairing（出短码 / 输对端短码发起出站）+
 * LAN 扫描。SSE 单通道：hook 域任一帧与 settings invalidate 都触发 peers 重拉
 * （不新开 EventSource、不轮询）。
 */
export function FederationSection(props: {
  enabled: boolean;
  discovery: boolean;
  onChange: (patch: { enabled?: boolean; discovery?: boolean }) => void;
}) {
  const { t } = useI18n();
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredPeer[] | null>(null);
  const [offerCode, setOfferCode] = useState<string | null>(null);
  const [offerExpiresAt, setOfferExpiresAt] = useState<number | null>(null);
  const [addName, setAddName] = useState('');
  const [addPort, setAddPort] = useState('');
  const [peerCodeName, setPeerCodeName] = useState('');
  const [peerCodeHost, setPeerCodeHost] = useState('');
  const [peerCodePort, setPeerCodePort] = useState('');
  const [peerCode, setPeerCode] = useState('');
  const [initiateBusy, setInitiateBusy] = useState(false);
  const [deleting, setDeleting] = useState<PeerRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initiateError, setInitiateError] = useState<string | null>(null);

  const reloadPeers = useCallback(() => {
    api
      .listPeers()
      .then((r) => setPeers(r.peers))
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    reloadPeers();
  }, [reloadPeers]);

  // SSE 单通道：服务端 peers 变更/心跳落地推 `{type:'invalidate', key:'federation'}`
  // 帧，这里接它重拉——在线态与列表变更不靠轮询。
  useEffect(() => {
    const offInv = registerInvalidator('federation', reloadPeers);
    return () => {
      offInv();
    };
  }, [reloadPeers]);

  const scan = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .discover()
      .then((r) => setDiscovered(r.peers))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, []);

  const createOffer = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .createPairingOffer()
      .then((r) => {
        setOfferCode(r.code);
        setOfferExpiresAt(r.expiresAt);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, []);

  const addManual = useCallback(() => {
    const port = Number(addPort);
    if (!addName.trim() || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      setError(t('settings.fedAddInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    api
      .createPeer({ name: addName.trim(), host: addName.trim(), port })
      .then(() => {
        setAddName('');
        setAddPort('');
        reloadPeers();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, [addName, addPort, reloadPeers, t]);

  const addDiscovered = useCallback(
    (d: DiscoveredPeer) => {
      setBusy(true);
      setError(null);
      api
        .createPeer({ name: d.txt.name || d.name, host: d.host, port: d.port })
        .then(reloadPeers)
        .catch((e) => setError(errorText(e)))
        .finally(() => setBusy(false));
    },
    [reloadPeers],
  );

  const removePeer = useCallback(() => {
    if (!deleting) return;
    setBusy(true);
    api
      .deletePeer(deleting.id)
      .then(reloadPeers)
      .catch((e) => setError(errorText(e)))
      .finally(() => {
        setBusy(false);
        setDeleting(null);
      });
  }, [deleting, reloadPeers]);

  // 出站 pairing（F1）：拿对端给的短码打对端。成功即 peer 行 + token 落盘。
  const initiatePairing = useCallback(() => {
    const port = Number(peerCodePort);
    if (!peerCodeName.trim() || !peerCodeHost.trim() || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      setInitiateError(t('settings.fedAddInvalid'));
      return;
    }
    if (!/^\d{6}$/.test(peerCode)) {
      setInitiateError(t('settings.fedInitiateCodeInvalid'));
      return;
    }
    setInitiateBusy(true);
    setInitiateError(null);
    api
      .initiatePairing({
        name: peerCodeName.trim(),
        host: peerCodeHost.trim(),
        port,
        code: peerCode,
      })
      .then(() => {
        setPeerCodeName('');
        setPeerCodeHost('');
        setPeerCodePort('');
        setPeerCode('');
        reloadPeers();
      })
      .catch((e) => setInitiateError(errorText(e)))
      .finally(() => setInitiateBusy(false));
  }, [peerCodeName, peerCodeHost, peerCodePort, peerCode, reloadPeers, t]);

  const inputCls =
    'rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500';

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 text-neutral-500" />
          <label className="flex items-center text-xs font-medium text-neutral-300">
            {t('settings.fedEnabled')}
            <FieldHint>{t('settings.fedEnabledHint')}</FieldHint>
          </label>
          <span className="ml-auto">
            <Switch
              checked={props.enabled}
              onChange={(v) => props.onChange({ enabled: v })}
              title={t('settings.fedEnabled')}
            />
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 text-neutral-500" />
          <label className="flex items-center text-xs font-medium text-neutral-300">
            {t('settings.fedDiscovery')}
            <FieldHint>{t('settings.fedDiscoveryHint')}</FieldHint>
          </label>
          <span className="ml-auto">
            <Switch
              checked={props.discovery}
              onChange={(v) => props.onChange({ discovery: v })}
              title={t('settings.fedDiscovery')}
            />
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
          {t('settings.fedPeers')}
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={createOffer}
              disabled={busy}
              className="rounded-lg bg-neutral-800 px-2 py-1 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
            >
              {t('settings.fedOffer')}
            </button>
            <button
              type="button"
              onClick={scan}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-neutral-800 px-2 py-1 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {t('settings.fedScan')}
            </button>
          </span>
        </label>

        {offerCode && (
          <p className="rounded-lg bg-neutral-800/60 px-2.5 py-1.5 text-11 text-neutral-300">
            {t('settings.fedOfferShown')}
            <code className="ml-1.5 text-sm tracking-widest text-blue-300">{offerCode}</code>
            {offerExpiresAt != null && (
              <span className="ml-2 text-neutral-500">
                {new Date(offerExpiresAt).toLocaleTimeString()}
              </span>
            )}
          </p>
        )}

        {peers.length === 0 ? (
          <p className="text-11 text-neutral-500">{t('settings.fedPeersEmpty')}</p>
        ) : (
          <ul className="space-y-1">
            {peers.map((p) => {
              const state = livenessOf(p.lastSeenAt);
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-lg bg-neutral-800/60 px-2.5 py-1.5 text-11 text-neutral-300"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${state === 'online' ? 'bg-blue-400' : 'bg-neutral-600'}`}
                    title={t(state === 'online' ? 'settings.fedOnline' : state === 'offline' ? 'settings.fedOffline' : 'settings.fedNeverSeen')}
                  />
                  <span className="truncate">{p.name}</span>
                  <span className="text-neutral-500">
                    {p.host}
                    {p.port > 0 ? `:${p.port}` : ''}
                  </span>
                  <span className="text-neutral-600">
                    {p.source === 'manual' ? t('settings.fedSrcManual') : p.source === 'pairing' ? t('settings.fedSrcPairing') : t('settings.fedSrcMdns')}
                  </span>
                  <span className="ml-auto" />
                  <button
                    type="button"
                    onClick={() => setDeleting(p)}
                    className="text-neutral-500 hover:text-red-400"
                    aria-label={t('settings.fedDelete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {discovered !== null && discovered.length > 0 && (
        <div className="space-y-1">
          <p className="text-11 text-neutral-500">{t('settings.fedDiscovered')}</p>
          <ul className="space-y-1">
            {discovered.map((d) => (
              <li
                key={`${d.host}:${d.port}`}
                className="flex items-center gap-2 rounded-lg bg-neutral-800/40 px-2.5 py-1.5 text-11 text-neutral-400"
              >
                <span className="truncate">{d.txt.name || d.name}</span>
                <span className="text-neutral-500">
                  {d.host}:{d.port}
                </span>
                <span className="ml-auto" />
                <button
                  type="button"
                  onClick={() => addDiscovered(d)}
                  disabled={busy}
                  className="flex items-center gap-0.5 rounded bg-neutral-800 px-1.5 py-0.5 hover:bg-neutral-700 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  {t('settings.fedAddFromScan')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          placeholder="10.0.0.2"
          className={`${inputCls} w-40`}
        />
        <input
          type="text"
          value={addPort}
          onChange={(e) => setAddPort(e.target.value)}
          placeholder="6443"
          className={`${inputCls} w-20`}
        />
        <button
          type="button"
          onClick={addManual}
          disabled={busy}
          className="flex items-center gap-1 rounded-lg bg-neutral-800 px-2 py-1.5 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          {t('settings.fedAdd')}
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
          {t('settings.fedInitiate')}
          <FieldHint>{t('settings.fedInitiateHint')}</FieldHint>
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={peerCodeName}
            onChange={(e) => setPeerCodeName(e.target.value)}
            placeholder={t('settings.fedInitiateName')}
            className={`${inputCls} w-28`}
          />
          <input
            type="text"
            value={peerCodeHost}
            onChange={(e) => setPeerCodeHost(e.target.value)}
            placeholder="10.0.0.2"
            className={`${inputCls} w-32`}
          />
          <input
            type="text"
            value={peerCodePort}
            onChange={(e) => setPeerCodePort(e.target.value)}
            placeholder="6443"
            className={`${inputCls} w-16`}
          />
          <input
            type="text"
            value={peerCode}
            onChange={(e) => setPeerCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className={`${inputCls} w-20 tracking-widest`}
          />
          <button
            type="button"
            onClick={initiatePairing}
            disabled={initiateBusy}
            className="flex items-center gap-1 rounded-lg bg-neutral-800 px-2 py-1.5 text-11 text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
          >
            {initiateBusy && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('settings.fedInitiateGo')}
          </button>
        </div>
        {initiateError && <p className="text-11 text-red-400">{initiateError}</p>}
      </div>

      {error && <p className="text-11 text-red-400">{error}</p>}

      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.fedDeleteConfirm')}
        message={deleting?.name ?? ''}
        confirmLabel={t('common.delete')}
        onConfirm={removePeer}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
