import { useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { CornerDownLeft, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { api, type SessionMessageRow } from '@/lib/api';
import { discardUpload, uploadFileWithProgress } from '@/lib/upload';
import { errorText, type ActionFeedback } from '@/lib/action-feedback';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { serializeDraft } from './draft-editor';
import {
  ATTACH_MAX_COUNT,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  isImageFile,
  type StagedFile,
} from './attach';
import { removableOf } from './conv-model';
import type { TFunc } from '@/i18n/t';

/**
 * 附件暂存 + 发送队列域：选文件三入口（选择器/粘贴/拖放）的类型与上限把关、
 * 上传进度、撤格；发送（层② 终端击键）、出队编辑、队列行操作（重发/取回/删除）。
 * staged 状态与在飞上传的取消把手归 hook 自持。
 */
export function useConvQueue(deps: {
  sessionId: string;
  /** 附件面收哪些类型（能力面；daemon 未升级缺席 = 不收）。 */
  attachKinds: string[];
  /** 附件暂存（主组件持有：草稿快照与 queue 两域共用）。 */
  staged: StagedFile[];
  setStaged: Dispatch<SetStateAction<StagedFile[]>>;
  /** 草稿 DOM 与镜像（发送/出队要读写）。 */
  draftRef: RefObject<HTMLDivElement | null>;
  setDraftText: (text: string) => void;
  /** 自己发的必然要看一眼：发送成功把贴底意图置回。 */
  stick: MutableRefObject<boolean>;
  fb: ActionFeedback;
  t: TFunc;
  show: (kind: 'success' | 'error', msg: string) => void;
  refreshMessages: () => Promise<void>;
  /** 队尾那条还没送出去的（出队按钮只给它）。 */
  newestQueuedId: string | undefined;
}) {
  const { sessionId, attachKinds, staged, setStaged, draftRef, setDraftText, stick, fb, t, show, refreshMessages, newestQueuedId } = deps;
  /** 在飞上传的取消把手（按 staged 本地键索引）。 */
  const uploadAborters = useRef(new Map<string, AbortController>());
  /** staged 本地键的自增尾号（同名同大小的两个文件各占一格）。 */
  const stagedSeq = useRef(0);

/** 选文件（文件选择器 / 粘贴 / 拖放三个入口共用）：类型与大小就地挡，
 *  上传进度画在自己的图标上，失败也挂在那一格（不弹窗、不吞）。 */
const stageFiles = (files: FileList | File[]): void => {
  const list = Array.from(files);
  if (list.length === 0) return;
  const kinds = attachKinds;
  // 上限按「本次已收 + 现有」算：`setStaged` 的 updater 是下一拍才跑的，
  // 靠它回填一个 accepted 标志会读到旧值（连选多个时全被拒或全被收）
  let room = Math.max(0, ATTACH_MAX_COUNT - staged.length);
  for (const f of list) {
    const image = isImageFile(f);
    if (image ? !kinds.includes('image') : !kinds.includes('file')) {
      show('error', t('tasks.msgAttachUnsupported'));
      continue;
    }
    if (image && !IMAGE_TYPES.includes(f.type)) {
      show('error', t('tasks.msgImageBadType'));
      continue;
    }
    if (image ? f.size > IMAGE_MAX_BYTES : f.size > FILE_MAX_BYTES) {
      show('error', t(image ? 'tasks.msgImageTooLarge' : 'tasks.msgAttachTooLarge'));
      continue;
    }
    if (room <= 0) {
      show('error', t('tasks.msgAttachTooMany'));
      continue;
    }
    room--;
    const key = `${f.name}:${f.size}:${f.lastModified}:${++stagedSeq.current}`;
    setStaged((s) => [
      ...s,
      {
        key,
        name: f.name || 'file',
        mediaType: f.type || 'application/octet-stream',
        size: f.size,
        progress: 0,
        state: 'uploading',
        file: f,
      },
    ]);
    const ctl = new AbortController();
    uploadAborters.current.set(key, ctl);
    const patch = (next: Partial<StagedFile>): void =>
      setStaged((s) => s.map((x) => (x.key === key ? { ...x, ...next } : x)));
    void uploadFileWithProgress(f, (ratio) => patch({ progress: ratio }), { signal: ctl.signal })
      .then((upload) => patch({ state: 'done', progress: 1, upload }))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') {
          setStaged((s) => s.filter((x) => x.key !== key));
          return;
        }
        patch({ state: 'error', error: errorText(e) });
      })
      .finally(() => uploadAborters.current.delete(key));
  }
};

/** 从附件条上撤掉一格（上传中的连临时件一起丢）。 */
const unstage = (item: StagedFile): void => {
  uploadAborters.current.get(item.key)?.abort();
  if (item.state === 'uploading' && item.file) discardUpload(item.file);
  setStaged((s) => s.filter((x) => x.key !== item.key));
};

const send = (): void => {
  // 从 DOM 现序列化：镜像可能落后一拍，而这一份是要真发出去的
  const text = serializeDraft(draftRef.current).trim();
  const files = staged.filter((s) => s.state === 'done' && s.upload).map((s) => s.upload!);
  if (!text && files.length === 0) return;
  setDraftText('');
  setStaged((s) => s.filter((x) => x.state !== 'done' || !x.upload));
  stick.current = true; // 自己发的必然要看一眼，不因正翻历史而沉在底下
  void fb.run(
    `sendMsg:${sessionId}`,
    async () => {
      const res = await api.sendSessionMessage(sessionId, {
        text,
        ...(files.length > 0 ? { attachments: files.map((i) => i.id) } : {}),
        // 手动面恒走层② 终端击键：直投/中继在宿主眼里都是「另一个会话发的」、
        // 且不带发送方，对方会话可能答给一个随机同伴——人工对话要的是用户权威
        forceTerminal: true,
      });
      // 目标会话判死 → 后端当场落 failed（reason=offline）：行会说清，但发送
      // 这个手势本身也要有回音（「发了没反应」正是用户撞过的坑）。
      if (res.message?.reason === 'offline') show('error', t('tasks.msgOfflineToast'));
      await refreshMessages();
    },
    { fail: (e) => t('tasks.msgSendFailed', { error: errorText(e) }) },
  );
};

/** 出队编辑：从队列里取回队尾那条（最新未发送），放回输入框改完再发。 */
const dequeue = (row: SessionMessageRow): void => {
  void fb.run(
    `dequeue:${row.id}`,
    async () => {
      await api.dismissSessionMessage(sessionId, row.id);
      const cur = serializeDraft(draftRef.current);
      setDraftText(cur.trim() ? `${cur}\n${row.text}` : row.text);
      setStaged((s) =>
        [
          ...s,
          ...(row.attachments ?? []).map((u) => ({
            key: `q:${u.id}`,
            name: u.name,
            mediaType: u.mediaType,
            size: u.size ?? 0,
            progress: 1,
            state: 'done' as const,
            upload: u,
          })),
        ].slice(0, ATTACH_MAX_COUNT),
      );
      await refreshMessages();
    },
    { fail: (e) => t('tasks.msgDequeueFailed', { error: errorText(e) }) },
  );
};

/** 队列每行右侧的操作（常显、纯图标，不占正文宽度）：补回车 / 重发 / 取回编辑 / 删除。 */
const queueActions = (m: SessionMessageRow) => (
  <>
    {/* 已发出（层② 终端）却没回执 = 文本多半已贴进输入框、只欠那记被吞掉的回车：
        补一记 Enter（提交的是整个输入框，与重发的「只补回车」同一语义）。 */}
    {m.status === 'delivered' && m.acked !== true && m.via === 'terminal' && (
      <button
        type="button"
        title={t('tasks.msgEnterHint')}
        aria-label={t('tasks.msgEnter')}
        disabled={fb.stateOf(`enter:${m.id}`) === 'loading'}
        onClick={() =>
          void fb.run(
            `enter:${m.id}`,
            async () => {
              await api.pressSessionEnter(sessionId);
              await refreshMessages();
            },
            { fail: (err) => t('tasks.msgEnterFailed', { error: errorText(err) }) },
          )
        }
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-blue-500/30 bg-blue-500/10 text-blue-300 transition-colors hover:border-blue-500/50 disabled:opacity-40"
      >
        <FeedbackIcon
          state={fb.stateOf(`enter:${m.id}`)}
          className="h-3 w-3"
          icon={<CornerDownLeft className="h-3 w-3" />}
        />
      </button>
    )}
    {(m.status === 'failed' || m.stalled === true) && (
      <button
        type="button"
        title={t('tasks.msgResend')}
        aria-label={t('tasks.msgResend')}
        disabled={fb.stateOf(`resend:${m.id}`) === 'loading'}
        onClick={() =>
          void fb.run(
            `resend:${m.id}`,
            async () => {
              await api.resendSessionMessage(sessionId, m.id);
              await refreshMessages();
            },
            { fail: (err) => t('tasks.msgResendFailed', { error: errorText(err) }) },
          )
        }
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-amber-500/30 bg-amber-950/30 text-amber-300 transition-colors hover:border-amber-500/50 disabled:opacity-40"
      >
        <FeedbackIcon
          state={fb.stateOf(`resend:${m.id}`)}
          className="h-3 w-3"
          icon={<RotateCcw className="h-3 w-3" />}
        />
      </button>
    )}
    {/* 队尾那条（最新还没送出去的）取回输入框改完再发——已送出去的行没有「改」这回事 */}
    {m.id === newestQueuedId && (
      <button
        type="button"
        title={t('tasks.outboxDequeueHint')}
        aria-label={t('tasks.outboxDequeue')}
        disabled={fb.stateOf(`dequeue:${m.id}`) === 'loading'}
        onClick={() => dequeue(m)}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-blue-500/30 bg-blue-500/10 text-blue-300 transition-colors hover:border-blue-500/50 disabled:opacity-40"
      >
        <FeedbackIcon
          state={fb.stateOf(`dequeue:${m.id}`)}
          className="h-3 w-3"
          icon={<Pencil className="h-3 w-3" />}
        />
      </button>
    )}
    {removableOf(m) && (
      <button
        type="button"
        title={t(
          m.status === 'pending'
            ? 'tasks.msgDismissQueuedHint'
            : m.status === 'delivering'
              ? 'tasks.msgDismissInflightHint'
              : 'tasks.msgDismissHint',
        )}
        aria-label={t('tasks.msgDismiss')}
        disabled={fb.stateOf(`dismiss:${m.id}`) === 'loading'}
        onClick={() =>
          void fb.run(
            `dismiss:${m.id}`,
            async () => {
              await api.dismissSessionMessage(sessionId, m.id);
              await refreshMessages();
            },
            { fail: (err) => t('tasks.msgDismissFailed', { error: errorText(err) }) },
          )
        }
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-edge/[0.12] text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200 disabled:opacity-40"
      >
        <FeedbackIcon
          state={fb.stateOf(`dismiss:${m.id}`)}
          className="h-3 w-3"
          icon={<Trash2 className="h-3 w-3" />}
        />
      </button>
    )}
  </>
);
  return { stageFiles, unstage, send, dequeue, queueActions };
}
