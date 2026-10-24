import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type ProjectRow, type ProjectStorageResult } from '@/lib/api';
import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import { errorText } from '@/lib/action-feedback';
import { DirectoryPickerModal, cleanPath } from '@/components/DirectoryPickerModal';
import { Image, FolderCog, Loader2, X } from 'lucide-react';

interface StorageSettingsModalProps {
  project: ProjectRow | null;
  onClose: () => void;
}

/**
 * 项目存储路径设置（项目卡设置按钮）：对话附件的图片/文件各自落哪。
 * 空 = 全局默认（`<data>/uploads`）；存量文件留原处，新上传走新路径。
 */
export function StorageSettingsModal({ project, onClose }: StorageSettingsModalProps) {
  const t = useT();
  const { show } = useToast();
  const [loaded, setLoaded] = useState<ProjectStorageResult | null>(null);
  const [images, setImages] = useState('');
  const [files, setFiles] = useState('');
  const [saving, setSaving] = useState(false);
  /** 正在为哪一档选目录（null = 选择器关着）。 */
  const [picking, setPicking] = useState<'images' | 'files' | null>(null);

  useEffect(() => {
    if (!project) return;
    setLoaded(null);
    api
      .getProjectStorage(project.id)
      .then((r) => {
        setLoaded(r);
        setImages(r.storage.images ?? '');
        setFiles(r.storage.files ?? '');
      })
      .catch((e: unknown) => {
        show('error', t('project.storageLoadFailed', { error: errorText(e) }));
        onClose();
      });
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    loaded !== null &&
    (images !== (loaded.storage.images ?? '') || files !== (loaded.storage.files ?? ''));

  const save = (): void => {
    if (!project || !dirty) return;
    setSaving(true);
    api
      .putProjectStorage(project.id, {
        images: images.trim() || null,
        files: files.trim() || null,
      })
      .then((r) => {
        setLoaded(r);
        setImages(r.storage.images ?? '');
        setFiles(r.storage.files ?? '');
        show('success', t('project.storageSaved'));
      })
      .catch((e: unknown) => show('error', t('project.storageSaveFailed', { error: errorText(e) })))
      .finally(() => setSaving(false));
  };

  // 移动端返回键/侧滑 = 关闭弹窗
  useBackPop(!!project, () => {
    onClose();
    return true;
  });

  if (!project) return null;

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6 max-lg:p-0">
          <div className="absolute inset-0 bg-black/60" onClick={onClose} />
          <div className="relative w-[560px] max-w-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col max-lg:h-full max-lg:max-h-none max-lg:max-w-none max-lg:rounded-none">
            <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted max-lg:px-3">
              <FolderCog className="h-4 w-4 text-blue-400" />
              <span className="text-sm font-semibold text-neutral-200">
                {t('project.storageTitle', { name: project.name })}
              </span>
              <button
                onClick={onClose}
                className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 max-lg:p-2"
                title={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-4 max-lg:p-3">
              {loaded === null ? (
                <div className="flex items-center justify-center py-10 text-neutral-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                <>
                  <p className="text-11 leading-relaxed text-neutral-500">
                    {t('project.storageIntro')}
                  </p>
                  {(['images', 'files'] as const).map((slot) => {
                    const value = slot === 'images' ? images : files;
                    const setValue = slot === 'images' ? setImages : setFiles;
                    const effective = loaded.effective[slot];
                    return (
                      <div key={slot} className="space-y-1.5">
                        <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                          {slot === 'images' ? (
                            <Image className="h-3.5 w-3.5 text-blue-400" />
                          ) : (
                            <FolderCog className="h-3.5 w-3.5 text-blue-400" />
                          )}
                          {t(slot === 'images' ? 'project.storageImages' : 'project.storageFiles')}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <input
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onBlur={() => setValue(cleanPath(value))}
                            placeholder={t('project.storagePlaceholder')}
                            spellCheck={false}
                            className="flex-1 min-w-0 rounded-lg border border-edge/[0.08] bg-neutral-900 px-2.5 py-1.5 text-xs font-mono text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setPicking(slot)}
                            className="shrink-0 rounded-lg border border-edge/[0.08] bg-edge/[0.02] px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.08]"
                          >
                            {t('project.storageBrowse')}
                          </button>
                        </div>
                        <p className="text-10 text-neutral-600">
                          {t('project.storageEffective', { dir: effective })}
                        </p>
                      </div>
                    )})}
                  <p className="text-10 leading-relaxed text-neutral-600">
                    {t('project.storageNotes')}
                  </p>
                </>
              )}
            </div>

            <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center gap-2 frosted max-lg:px-3">
              <p className="min-w-0 flex-1 truncate text-10 text-neutral-600">
                {t('project.storageKeepHint')}
                {dirty && <span className="text-amber-400"> · {t('common.unsaved')}</span>}
              </p>
              <button
                onClick={onClose}
                className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 max-lg:py-2"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed max-lg:py-2"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {/* 目录选择器（单选语义：确认取第一项） */}
      <DirectoryPickerModal
        open={picking !== null}
        onClose={() => setPicking(null)}
        onConfirm={(paths) => {
          const picked = paths[0];
          if (picking && picked) (picking === 'images' ? setImages : setFiles)(cleanPath(picked));
          setPicking(null);
        }}
      />
    </>
  );
}
