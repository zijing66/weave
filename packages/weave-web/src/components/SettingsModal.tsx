import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type DaemonSettings, type TerminalPreset } from '@/lib/api';
import { Settings, Terminal, X } from 'lucide-react';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Daemon settings dialog (top-right gear). Currently a single setting: which
 * terminal "open in terminal" launches. Presets offered come from the server,
 * so the dropdown only shows options valid for the daemon's platform.
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<DaemonSettings | null>(null);
  const [presets, setPresets] = useState<Array<{ id: TerminalPreset; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api
      .getDaemonSettings()
      .then((r) => {
        setSettings(r.settings);
        setPresets(r.presets);
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const preset = settings?.terminal.preset ?? 'auto';
  const customCommand = settings?.terminal.customCommand ?? '';

  async function handleSave(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.putDaemonSettings(settings);
      setSettings(saved);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[440px] max-w-full rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
          <Settings className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-semibold text-neutral-200">设置</span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              <Terminal className="h-3.5 w-3.5 text-neutral-500" />
              默认终端
            </label>
            <p className="text-[11px] text-neutral-500">
              「在终端中打开」使用的终端程序；自动模式会探测当前系统可用的终端。
            </p>
            <select
              value={preset}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, terminal: { ...s.terminal, preset: e.target.value as TerminalPreset } } : s,
                )
              }
              className="w-full rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {preset === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-300">自定义命令</label>
              <p className="text-[11px] text-neutral-500">
                <code className="text-neutral-400">{'{path}'}</code>{' '}
                会被替换为带引号的项目路径，例如：
                <code className="text-neutral-400"> alacritty -e cd {'{path}'}</code>
              </p>
              <input
                type="text"
                value={customCommand}
                onChange={(e) =>
                  setSettings((s) =>
                    s
                      ? { ...s, terminal: { ...s.terminal, customCommand: e.target.value } }
                      : s,
                  )
                }
                placeholder="my-terminal --dir {path}"
                className="w-full rounded-lg bg-neutral-800 border border-white/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          )}

          {error && <p className="text-[11px] text-red-400 break-all">{error}</p>}
        </div>

        <footer className="shrink-0 border-t border-white/[0.06] px-4 py-2.5 flex items-center gap-2 frosted">
          <span className="flex-1 text-[11px] text-neutral-500">
            {settings === null && !error ? '加载中…' : ''}
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            取消
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={settings === null || saving}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
