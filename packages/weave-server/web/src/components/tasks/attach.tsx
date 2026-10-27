import type { ReactElement, ReactNode } from 'react';
import { AlertTriangle, FileCode, Image as ImageIcon, X } from 'lucide-react';
import { API_BASE, type UploadFile } from '@/lib/api';
import { cn } from '@/lib/utils';

/** 附件口径（与服务端 UPLOAD_* 同值）：图就这四种，其余按「文件」收。 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 普通文件的上限（服务端 `UPLOAD_FILE_MAX_BYTES`）。 */
export const FILE_MAX_BYTES = 512 * 1024 * 1024;
export const ATTACH_MAX_COUNT = 8;

/** 图片判据：MIME 或扩展名（移动浏览器的剪贴板项偶尔不带 type）。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export const isImageFile = (f: File): boolean =>
  f.type.startsWith('image/') || (!f.type && IMAGE_EXT.test(f.name));

/**
 * 剪贴板/拖放里的文件（图与普通文件都收，类型是否可发由 `stageFiles` 判）。
 * **移动浏览器只填 `items`**（iOS Safari 的 `files` 恒空），桌面才稳定给 `files`
 * ⇒ items 优先、files 兜底；只取 file 项，文字项留着走默认粘贴。
 * 拖进来的**文件夹**不是可上传件（浏览器只给一个 size=0、无类型的假 File）：
 * 按 entry 判掉，免得占一格再失败。
 */
export function attachedFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const isDir = (i: DataTransferItem): boolean => {
    try {
      return i.webkitGetAsEntry?.()?.isDirectory === true;
    } catch {
      return false;
    }
  };
  const fileItems = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  // items 里有 file 项就以它为准（`files` 兜底会把刚判掉的文件夹又捡回来）
  if (fileItems.length > 0) {
    return fileItems
      .filter((i) => !isDir(i))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
  }
  return Array.from(dt.files ?? []);
}

/** 附件条上的一格：上传中/已落盘/失败都摆在同一个位置（进度条画在图标上）。 */
export interface StagedFile {
  /** 前端本地键（同一份文件拖两次也是两格）。 */
  key: string;
  name: string;
  mediaType: string;
  size: number;
  /** 0..1；1 = 已落盘。 */
  progress: number;
  state: 'uploading' | 'done' | 'error';
  /** 已落盘的上传件（state='done' 时必有）。 */
  upload?: UploadFile;
  /** 失败原因（挂在图标上，不弹窗）。 */
  error?: string;
  /** 原始 File（只在内存里；撤掉上传中的格子时用它丢服务端半截件）。 */
  file?: File;
}

/** 上传件是不是图（决定出缩略图还是文件行）。 */
export const isImageUpload = (a: { mediaType: string }): boolean =>
  (IMAGE_TYPES as readonly string[]).includes(a.mediaType);

/** 附件条里已经落盘的那些（草稿快照只存这一份：上传中的刷新后没法续读文件本身）。 */
export const settledUploads = (staged: readonly StagedFile[]): UploadFile[] =>
  staged.flatMap((s) => (s.state === 'done' && s.upload ? [s.upload] : []));

/** 文件大小的可读形状（附件格里的副标题）。 */
export function sizeLabel(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** 附件条上的一格：图出缩略图（点开大图）、文件只出图标 + 名字（不预览）；
 *  上传中的进度（小进度条 + 百分比）就画在这一格上——别处再摆一条总进度，
 *  反而看不清是哪一个在传。右上角一枚常显角标：撤格（X，连正文里的占位胶囊
 *  一起摘——占位与暂存格是同一条附件的两个面）。 */
export function StagedTile({
  item,
  onOpen,
  onRemove,
  removeLabel,
}: {
  item: StagedFile;
  onOpen: (u: UploadFile) => void;
  onRemove: () => void;
  removeLabel: string;
}): ReactElement {
  const pct = Math.round(item.progress * 100);
  const isImage = isImageUpload(item);
  const thumb = isImage && item.state === 'done' && item.upload;
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        title={
          item.state === 'error'
            ? `${item.name} — ${item.error ?? ''}`
            : [item.name, sizeLabel(item.size)].filter(Boolean).join(' · ')
        }
        onClick={() => {
          if (item.state === 'done' && item.upload) onOpen(item.upload);
        }}
        className={cn(
          'relative flex shrink-0 items-center overflow-hidden rounded border bg-neutral-950',
          isImage ? 'h-10 w-10 justify-center' : 'h-10 max-w-[10rem] gap-1 px-1.5',
          item.state === 'error'
            ? 'border-red-500/50'
            : 'border-edge/[0.12]',
        )}
      >
        {thumb ? (
          <img
            src={`${API_BASE}/images/${item.upload!.id}`}
            alt={item.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : isImage ? (
          <ImageIcon className="h-4 w-4 text-neutral-400" />
        ) : (
          <>
            <FileCode className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            <span className="min-w-0 truncate text-10 text-neutral-300">{item.name}</span>
          </>
        )}
        {item.state === 'uploading' && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-9 font-medium text-white">
            {pct}%
          </span>
        )}
        {item.state === 'uploading' && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
            <span className="block h-full bg-blue-400 transition-[width]" style={{ width: `${pct}%` }} />
          </span>
        )}
        {item.state === 'error' && (
          <span className="absolute inset-0 flex items-center justify-center bg-red-950/60">
            <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
          </span>
        )}
      </button>
      <button
        type="button"
        title={removeLabel}
        aria-label={removeLabel}
        onClick={onRemove}
        className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-edge/[0.15] bg-neutral-800 text-neutral-300 hover:border-red-500/50 hover:text-red-300 max-lg:h-5 max-lg:w-5"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

/** 附件预览区的一段（图片区 / 文件区各自一段）：标签 + 该类的格子。 */
export function StagedRow({
  label,
  items,
  children,
}: {
  label: string;
  items: StagedFile[];
  children: ReactNode;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="shrink-0 text-10 text-neutral-500">{label}</span>
      {children}
    </div>
  );
}
