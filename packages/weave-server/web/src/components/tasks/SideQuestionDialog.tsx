import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  MessageCircleQuestion,
  X,
} from 'lucide-react';
import { AssistantMarkdown } from '@/components/AiAssistant';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { useToast } from '@/components/Toast';
import { api, type SideQuestionRow } from '@/lib/api';
import { copyImage, copyText } from '@/lib/clipboard';
import {
  downloadBlob,
  imageFileName,
  renderConversationImage,
  type ConvImageEntry,
} from '@/lib/conv-image';
import { subscribeHook } from '@/lib/sse';
import { usePullLoad } from '@/lib/pull-load';
import { useMediaQuery } from '@/lib/use-media-query';
import { useTheme } from '@/lib/theme';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 一页多少条（历史很短，10 条够一次翻到底）。 */
const PAGE = 10;

const MENU_W = 168;
const MENU_H = 72;

/** 触屏双击开菜单的两枚门槛（与对话面板同口径）：两击落在同一条折叠条、
 *  间隔不超过 DOUBLE_TAP_MS；位移超过 TAP_SLOP 就当是滚动。 */
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

const stamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 导出用时刻戳：本地 `YYYY-MM-DD HH:mm:ss`。展示用的 `stamp` 是给人扫的短形
 *  （当天只给时分），粘到别处会失去日期。 */
const fullStamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
};

/** 复制的正文：一问一答各一段、段间空行（形状与对话导出一致）。没等到回答的
 *  只有问那一段。角色文案由调用方给（i18n 不写进纯函数）。 */
const rowsText = (
  rows: readonly SideQuestionRow[],
  labels: { ask: string; answer: string },
): string =>
  rows
    .flatMap((r) => {
      const ask = `[${fullStamp(r.askedAt)}] ${labels.ask}\n${r.question}`;
      if (r.status !== 'answered') return [ask];
      const at = fullStamp(r.answeredAt ?? r.askedAt);
      return [ask, `[${at}] ${labels.answer}\n${r.answer ?? ''}`];
    })
    .join('\n\n');

/** 出图的条目：一问一答两条，角色沿用对话那套 user/assistant 配色。 */
const rowsImageEntries = (rows: readonly SideQuestionRow[]): ConvImageEntry[] =>
  rows.flatMap((r) => {
    const ask: ConvImageEntry = { role: 'user', at: r.askedAt, text: r.question };
    if (r.status !== 'answered') return [ask];
    return [ask, { role: 'assistant', at: r.answeredAt ?? r.askedAt, text: r.answer ?? '' }];
  });

/** 弹出菜单两副面孔：折叠条右键（进多选）/ 底栏分享图片（复制 | 下载）。 */
type SideMenu =
  | { kind: 'row'; x: number; y: number; id: number }
  | { kind: 'share'; x: number; y: number };

/** 多选态折叠条旁的勾选框（点击面是整条，这里只显示状态）。 */
function CheckBox({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
        on ? 'border-blue-400 bg-blue-500 text-white' : 'border-neutral-600 bg-neutral-900',
      )}
    >
      {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
    </span>
  );
}

/**
 * 旁路会话（claude = `/btw`）：问一句不打扰主回合的话，回答只落在这里。
 *
 * 为什么得有这扇弹窗：宿主的侧问开着 `skipTranscript`——问题与回答**都不落
 * 任何文件**，宿主面板的历史也只在它自己的内存里。所以 weave 发出去的问句由
 * 自己记（服务端 `side_questions`），回答由之后那条采集事件认领回来。
 *
 * 发送恒走层② 终端击键（旁路只活在 TUI 里），服务端只收「用户的原文」——
 * 命令文法归 harness 能力面。
 *
 * 每条旁路是一根**折叠条**：头部一行（时刻 + 问句摘要 + 状态），点开才是完整
 * 问答；最新那条缺省展开（新发出去的也自动展开）。复制与「选中分享」
 * 与对话面板同口径——右键（触屏双击）开菜单进多选，底栏换工具条，出图复用
 * `renderConversationImage` 那套 canvas 卡片。
 */
export function SideQuestionDialog({
  sessionId,
  label,
  onClose,
}: {
  sessionId: string;
  /** 会话显示名（标题回退 id 短前缀）。 */
  label: string;
  onClose: () => void;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const { show } = useToast();
  const theme = useTheme();
  /** 已加载的行（**倒序**：与接口同序，渲染时反转成对话序）。 */
  const [rows, setRows] = useState<SideQuestionRow[] | null>(null);
  const [headDone, setHeadDone] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draft, setDraft] = useState('');
  /** 展开的折叠条（缺省只展开最新那条；缺省靠下面那个「新到即展开」的 effect 落）。 */
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const seenMax = useRef(0);
  /** 多选态：点折叠条即勾选，底栏换成工具条。 */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
  const [menu, setMenu] = useState<SideMenu | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** 手指这会儿落在哪条折叠条上（判断这一击是不是轻点：位移超阈值即作废）。 */
  const tap = useRef<{ id: number; x: number; y: number } | null>(null);
  /** 上一次轻点：同一条、间隔够短 = 双击，开菜单。 */
  const lastTap = useRef<{ id: number; at: number } | null>(null);
  const coarse = useMediaQuery('(pointer: coarse)');

  /** 合并一页（按 id 去重、新页覆盖旧页——同一条的 status 会从 pending 变 answered）。 */
  const merge = useCallback((page: SideQuestionRow[]): void => {
    setRows((prev) => {
      const byId = new Map<number, SideQuestionRow>();
      for (const r of prev ?? []) byId.set(r.id, r);
      for (const r of page) byId.set(r.id, r);
      return [...byId.values()].sort((a, b) => b.id - a.id);
    });
  }, []);

  /** 最新一页（打开时与收到认领帧时都走它）。 */
  const reload = useCallback(async (): Promise<void> => {
    const page = await api.listSideQuestions(sessionId, { limit: PAGE });
    merge(page);
    setHeadDone(page.length < PAGE);
  }, [sessionId, merge]);

  useEffect(() => {
    let alive = true;
    reload().catch(() => {
      // 首屏失败：留空表（发送仍可用），错误在发送路径上报
      if (alive) setRows([]);
    });
    return () => {
      alive = false;
    };
  }, [reload]);

  // 认领 = 一次转场（旁路回答到账）：重拉最新一页即可，不做增量协议
  useEffect(
    () =>
      subscribeHook(
        (frame) => {
          if (frame.sessionId === sessionId) void reload().catch(() => {});
        },
        ['sideQuestion.answered'],
      ),
    [sessionId, reload],
  );

  // 新发出去的那条自动展开（缺省展开最新的就是这条）；接口倒序，rows[0] 即最新。
  // 只认严格更新的 id：翻更早的页不会把旧条重新弹开，用户手收的那条也不再弹。
  useEffect(() => {
    const max = rows?.[0]?.id;
    if (max === undefined || max <= seenMax.current) return;
    seenMax.current = max;
    setOpened((prev) => new Set(prev).add(max));
  }, [rows]);

  // Esc 逐层退：菜单 → 多选态 → 关弹窗（与对话面板同口径，别一把关掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else if (selecting) {
        setSelecting(false);
        setPicked(new Set());
      } else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, selecting, onClose]);

  // 菜单外点一下就关（并吞掉这一下：否则同一击会顺手把折叠条展开/收起）
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-side-menu]')) return;
      e.stopPropagation();
      setMenu(null);
    };
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('contextmenu', dismiss, true);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('contextmenu', dismiss, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  /** 取更早一页（拉动触发；贴顶不动不取）。 */
  const loadEarlier = async (): Promise<void> => {
    const oldest = rows?.[rows.length - 1];
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.listSideQuestions(sessionId, { beforeId: oldest.id, limit: PAGE });
      merge(page);
      setHeadDone(page.length < PAGE);
    } catch {
      // 翻了没翻到不算错（下次拉动再试）
    } finally {
      setLoadingEarlier(false);
    }
  };
  const pull = usePullLoad({
    axis: 'top',
    getEdge: () => (threadRef.current?.scrollTop ?? 1) <= 1,
    onFire: () => void loadEarlier(),
    enabled: rows !== null && !headDone && !loadingEarlier,
  });

  const thread = rows === null ? null : [...rows].reverse();
  const tailKey = thread && thread.length > 0 ? String(thread[thread.length - 1]!.id) : undefined;
  const lastTail = useRef<string | undefined>(undefined);
  // 新行（刚发出去 / 刚认领到）贴底；翻更早时不动视线
  useLayoutEffect(() => {
    if (tailKey === undefined || tailKey === lastTail.current) return;
    lastTail.current = tailKey;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tailKey]);

  const busy = fb.stateOf('sideAsk') === 'loading';
  const send = (): void => {
    const question = draft.trim();
    if (!question || busy) return;
    void fb.run(
      'sideAsk',
      async () => {
        const { sideQuestion } = await api.askSideQuestion(sessionId, question);
        merge([sideQuestion]);
        setDraft('');
      },
      { fail: (e) => t('tasks.sideFailed', { error: errorText(e) }) },
    );
  };

  const toggleOpen = (id: number): void =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const togglePick = (id: number): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const enterSelect = (id?: number): void => {
    setMenu(null);
    setSelecting(true);
    if (id !== undefined) setPicked(new Set([id]));
  };

  /** 勾上的行（顺序 = 对话序）。全选的范围 = 已加载的全部条目，不随过滤变。 */
  const pickedRows = (thread ?? []).filter((r) => picked.has(r.id));
  const allPicked = thread !== null && thread.length > 0 && thread.every((r) => picked.has(r.id));
  const toggleAll = (): void =>
    setPicked(allPicked ? new Set() : new Set((thread ?? []).map((r) => r.id)));

  const copyRows = (chosen: readonly SideQuestionRow[]): void => {
    if (chosen.length === 0) return;
    const text = rowsText(chosen, {
      ask: t('tasks.sideRoleAsk'),
      answer: t('tasks.sideRoleAnswer'),
    });
    // 复制失败不静默：要让用户看得见（还可手动选中文本复制）
    void copyText(text).then((ok) =>
      show(
        ok ? 'success' : 'error',
        ok ? t('tasks.convCopyOk', { n: chosen.length }) : t('tasks.convCopyFailed'),
      ),
    );
  };

  /** 选中 → 图片：canvas 文本卡片，复制到剪贴板或下载 PNG（与对话面板同一套）。 */
  const shareImage = (to: 'clipboard' | 'download'): void => {
    const chosen = pickedRows;
    if (chosen.length === 0) return;
    setMenu(null);
    void fb.run(
      'sideImg',
      async () => {
        let blob: Blob;
        try {
          blob = await renderConversationImage(rowsImageEntries(chosen), {
            title: `${t('tasks.sideTitle')} · ${label}`,
            subtitle: t('tasks.convImgSubtitle', {
              at: fullStamp(new Date().toISOString()),
              n: chosen.length,
            }),
            labels: {
              user: t('tasks.sideRoleAsk'),
              assistant: t('tasks.sideRoleAnswer'),
            },
            stamp: fullStamp,
            theme,
          });
        } catch (e) {
          throw new Error(t('tasks.convImgFailed', { error: errorText(e) }));
        }
        if (to === 'download') {
          downloadBlob(blob, imageFileName(label));
          show('success', t('tasks.convImgSaved'));
        } else if (await copyImage(blob)) {
          show('success', t('tasks.convImgOk', { n: chosen.length }));
        } else {
          throw new Error(t('tasks.convImgCopyFailed'));
        }
      },
      { fail: errorText },
    );
  };

  /** 分享菜单往上开：底栏在下沿，向下没有可用的地方。 */
  const openShareMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ kind: 'share', x: r.right - MENU_W, y: r.top - MENU_H });
  };

  /** 触屏双击开菜单（桌面走右键）。多选只是菜单里的一项，双击也只开菜单。 */
  const onPressDown = (id: number) => (e: React.PointerEvent): void => {
    if (!coarse || selecting || e.button !== 0) return;
    tap.current = { id, x: e.clientX, y: e.clientY };
  };
  const onPressMove = (e: React.PointerEvent): void => {
    const p = tap.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.x) > TAP_SLOP || Math.abs(e.clientY - p.y) > TAP_SLOP) {
      tap.current = null;
    }
  };
  const onPressUp = (id: number) => (e: React.PointerEvent): void => {
    const p = tap.current;
    tap.current = null;
    if (!p || p.id !== id) return;
    const now = Date.now();
    const prev = lastTap.current;
    lastTap.current = { id, at: now };
    if (!prev || prev.id !== id || now - prev.at > DOUBLE_TAP_MS) return;
    lastTap.current = null;
    setMenu({ kind: 'row', x: e.clientX, y: e.clientY, id });
  };
  const cancelTap = (): void => {
    tap.current = null;
  };

  /** 每根折叠条的交互面：桌面右键开菜单，触屏双击同效；多选态里点条即勾选。 */
  const rowProps = (id: number): React.HTMLAttributes<HTMLLIElement> => ({
    onContextMenu: (e) => {
      if (selecting) return;
      // 触屏不压原生长按：那条路是「选中文字 + 系统复制」，自家菜单走双击
      if (coarse) return;
      e.preventDefault();
      setMenu({ kind: 'row', x: e.clientX, y: e.clientY, id });
    },
    onPointerDown: onPressDown(id),
    onPointerMove: onPressMove,
    onPointerUp: onPressUp(id),
    onPointerCancel: cancelTap,
    onClick: selecting ? () => togglePick(id) : undefined,
  });

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-[50] flex items-center justify-center bg-black/50 p-4"
          onClick={onClose}
        >
          <div
            className={cn(
              'relative flex w-full flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 p-3 shadow-mac',
              // <lg 整屏单列（与作答弹窗同口径：移动端没有拖窗口这回事）
              'max-h-[calc(100dvh_-_2rem)] lg:h-[32rem] lg:w-[36rem] max-lg:h-[90dvh]',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 pb-2">
              <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-neutral-200">
                <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                {t('tasks.sideTitle')} · {label}
              </p>
              <button
                type="button"
                title={t('tasks.messagesClose')}
                aria-label={t('tasks.messagesClose')}
                onClick={onClose}
                className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="pb-2 text-[11px] leading-relaxed text-neutral-500">{t('tasks.sideHint')}</p>

            <div
              ref={threadRef}
              onScroll={pull.syncEdge}
              onWheel={(e) => pull.wheel(e.deltaY, e.deltaMode)}
              onTouchStart={(e) => pull.touchStart(e.touches[0]?.clientY ?? 0)}
              onTouchMove={(e) => pull.touchMove(e.touches[0]?.clientY ?? 0)}
              onTouchEnd={pull.touchEnd}
              onTouchCancel={pull.touchEnd}
              className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border border-edge/[0.06] bg-edge/[0.02] p-2"
            >
              {pull.px > 0 && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 flex justify-center text-[10px] text-neutral-500"
                  style={{ transform: `translateY(${pull.px}px)` }}
                >
                  {loadingEarlier ? t('tasks.sideLoading') : t('tasks.sidePullOlder')}
                </div>
              )}
              {thread === null ? (
                <p className="py-6 text-center text-[11px] text-neutral-500">
                  {t('tasks.sideLoading')}
                </p>
              ) : thread.length === 0 ? (
                <p className="py-6 text-center text-[11px] text-neutral-500">{t('tasks.sideEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {thread.map((row) => {
                    const open = opened.has(row.id);
                    return (
                      <li
                        key={row.id}
                        {...rowProps(row.id)}
                        className={cn(
                          'rounded-lg border transition-colors',
                          selecting && picked.has(row.id)
                            ? 'border-blue-500/40 bg-blue-500/[0.06]'
                            : 'border-edge/[0.06] bg-edge/[0.02]',
                          selecting && 'select-none',
                        )}
                      >
                        <div className="flex items-center gap-1.5 px-2 py-1.5">
                          {selecting ? (
                            <>
                              <CheckBox on={picked.has(row.id)} />
                              <span className="shrink-0 text-[10px] text-neutral-600">
                                {stamp(row.askedAt)}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                                {row.question}
                              </span>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                aria-expanded={open}
                                onClick={() => toggleOpen(row.id)}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                              >
                                {open ? (
                                  <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
                                )}
                                <span className="shrink-0 text-[10px] text-neutral-600">
                                  {stamp(row.askedAt)}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                                  {row.question}
                                </span>
                              </button>
                              <button
                                type="button"
                                title={t('tasks.convCopy')}
                                aria-label={t('tasks.convCopy')}
                                onClick={() => copyRows([row])}
                                className="shrink-0 rounded p-0.5 text-neutral-600 transition-colors hover:text-neutral-200"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            </>
                          )}
                          {row.status === 'pending' && (
                            <Loader2
                              title={t('tasks.sidePending')}
                              className="h-3 w-3 shrink-0 animate-spin text-neutral-500"
                            />
                          )}
                          {row.status === 'timeout' && (
                            <AlertTriangle
                              title={t('tasks.sideTimeout')}
                              className="h-3 w-3 shrink-0 text-amber-400/80"
                            />
                          )}
                        </div>
                        {open && (
                          <div className="flex flex-col gap-1 px-2 pb-2">
                            {/* 问与答都走对话里那套 markdown 预览（同一个渲染器），
                                `pre-wrap` 保住段落里的软换行——回答常是多段 markdown */}
                            <div className="whitespace-pre-wrap break-words rounded-lg bg-edge/[0.04] px-2 py-1 text-xs text-neutral-200 [&_p]:whitespace-pre-wrap">
                              <AssistantMarkdown text={row.question} />
                            </div>
                            {row.status === 'answered' ? (
                              <div className="whitespace-pre-wrap break-words rounded-lg border border-violet-400/20 bg-violet-500/[0.06] px-2 py-1 text-xs leading-relaxed text-neutral-300 [&_p]:whitespace-pre-wrap">
                                <AssistantMarkdown text={row.answer ?? ''} />
                              </div>
                            ) : (
                              <p
                                className={cn(
                                  'flex items-center gap-1 px-2 text-[11px]',
                                  row.status === 'pending'
                                    ? 'text-neutral-500'
                                    : 'text-amber-300/80',
                                )}
                              >
                                {row.status === 'pending' && (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                )}
                                {row.status === 'pending'
                                  ? t('tasks.sidePending')
                                  : t('tasks.sideTimeout')}
                              </p>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* 多选态：composer 换成工具条（与对话面板同口径，窄屏整组折行） */}
            {selecting ? (
              <div className="mt-2 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="min-w-0 truncate text-[11px] text-neutral-400">
                  {t('tasks.convSelected', { n: picked.size })}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={thread === null || thread.length === 0}
                    onClick={toggleAll}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40',
                      allPicked
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                        : 'border-edge/[0.1] text-neutral-200 hover:border-edge/20',
                    )}
                  >
                    <CheckCheck className="h-3 w-3" />
                    {t(allPicked ? 'tasks.convDeselectAll' : 'tasks.convSelectAll')}
                  </button>
                  <button
                    type="button"
                    disabled={picked.size === 0}
                    onClick={() => copyRows(pickedRows)}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:border-edge/20 disabled:opacity-40"
                  >
                    <Copy className="h-3 w-3" />
                    {t('tasks.convCopy')}
                  </button>
                  <button
                    type="button"
                    disabled={picked.size === 0}
                    onClick={openShareMenu}
                    title={t('tasks.convShare')}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:border-edge/20 disabled:opacity-40"
                  >
                    <FeedbackIcon
                      state={fb.stateOf('sideImg')}
                      className="h-3 w-3"
                      icon={<ImageIcon className="h-3 w-3" />}
                    />
                    {t('tasks.convShare')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelecting(false);
                      setPicked(new Set());
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200"
                  >
                    {t('tasks.convCancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex shrink-0 items-center gap-2">
                <input
                  value={draft}
                  disabled={busy}
                  placeholder={t('tasks.sidePlaceholder')}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    send();
                  }}
                  className="min-w-0 flex-1 rounded border border-edge/[0.08] bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-edge/20 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={send}
                  className="flex shrink-0 items-center gap-1 rounded bg-violet-700/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-600 disabled:opacity-40"
                >
                  {t('tasks.answerSend')}
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* 菜单挂在 body 上（弹窗 z-50 之上的一层）：坐标按视口定位 */}
      {menu &&
        createPortal(
          <div
            data-side-menu
            className="fixed z-[60] rounded-lg border border-edge/[0.1] bg-neutral-900 py-1 shadow-mac"
            style={{
              left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.kind === 'row' ? (
              <button
                type="button"
                onClick={() => enterSelect(menu.id)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
              >
                <Check className="h-3 w-3 text-neutral-500" />
                {t('tasks.convSelect')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => shareImage('clipboard')}
                  className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
                >
                  <Copy className="h-3 w-3 text-neutral-500" />
                  {t('tasks.convShareCopy')}
                </button>
                <button
                  type="button"
                  onClick={() => shareImage('download')}
                  className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
                >
                  <Download className="h-3 w-3 text-neutral-500" />
                  {t('tasks.convShareDownload')}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
