import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertTriangle, Ban, Check, CheckCheck, ChevronDown, ChevronUp, Copy, CornerDownLeft, Download, FileCode, FileDiff, FileText, HelpCircle, Image as ImageIcon, Loader2, Maximize, MessageCircleQuestion, Minimize, Minus, Paperclip, RotateCcw, Send, Square, Trash2, X } from 'lucide-react';
import type { HarnessLifecycle } from '@weavecode/core/harness';
import {
  API_BASE,
  api,
  type CommandInputModeRow,
  type HarnessCommandRow,
  type MessagingCapability,
  type UploadFile,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { EnumSlider } from '@/components/ui/enum-slider';
import { AssistantMarkdown } from '@/components/ui/assistant-markdown';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useMediaQuery } from '@/lib/use-media-query';
import { useBackPop } from '@/lib/back-pop';
import { useTheme } from '@/lib/theme';
import { FilePicker, type PickTarget } from './FilePicker';
import { SessionEditsDialog } from './SessionEditsDialog';
import { SideQuestionDialog } from './SideQuestionDialog';
import { StatuslineBar } from './StatuslineBar';
import { SessionStatusIcon } from './SessionStatusIcon';
import { errorText, useActionFeedback, type ActionState } from '@/lib/action-feedback';
import { formatStamp } from '@/lib/hook-payload';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { useSessionStatus } from './session-status-store';
import { useConvThread } from './use-conv-thread';
import { useDraftEditor } from './use-draft-editor';
import { useConvSelect } from './use-conv-select';
import { useConvShare } from './use-conv-share';
import { useConvQueue } from './use-conv-queue';
import { useSessionControls } from './use-session-controls';
import { useConvWindow } from './use-conv-window';
import {
  ATTACH_MAX_COUNT,
  IMAGE_TYPES,
  attachedFilesFrom,
  isImageUpload,
  sizeLabel,
  StagedRow,
  StagedTile,
  type StagedFile,
} from './attach';
import {
  countdownLabel,
  editsWindowOf,
  hasVisualizeRef,
  imageMarkerSegments,
  pipePathSegments,
  visualizeSegments,
  CONV_FILTERS,
  STATUS_BADGE,
  STATUS_KEY,
  queueStatusKey,
  isRemotePrompt,
} from './conv-model';
import { VizSegments } from './VisualizationFrame';
import {
  cmdChipClass,
  commandModeClass,
  commandModeOf,
  commandTokensOf,
  serializeDraft,
  ATTACH_ATTR,
  REF_ATTR,
  type CmdSigil,
  type CmdInfo,
} from './draft-editor';
import {
  CheckBox,
  Collapsible,
  EventTicker,
  LightboxBackPop,
  MENU_H,
  MENU_W,
} from './conv-widgets';
import { NarrationStack, stackUnitsOf } from './conv-stack';

/** ESC 键帽点完歇几秒：连点会连发好几记（宿主的 ESC 后面接 rewind，连发会把
 *  刚开的那层菜单也退掉）。冷却只为防连发，与「能不能点」无关。 */
const ESC_COOLDOWN_S = 3;

/** 输入框高度（行数）：桌面顶边可拖，2~20 行，localStorage 记住。 */
const INPUT_ROWS_MIN = 2;
const INPUT_ROWS_MAX = 20;
/** 一行的高度（px）：拖拽位移换算行数用，与 textarea 的实际行高同量级。 */
const INPUT_ROW_PX = 16;

/** 发送快捷键：`ctrl-enter` = Ctrl+Enter 发送 / Enter 换行；`enter` = 反过来。
 *  全局偏好，localStorage 记住（与输入框行数同一口径）。 */
type SendKeyMode = 'ctrl-enter' | 'enter';
const SEND_KEY_KEY = 'weave:conv-send-key';
const sendKeyOf = (): SendKeyMode =>
  localStorage.getItem(SEND_KEY_KEY) === 'enter' ? 'enter' : 'ctrl-enter';


/**
 * 会话对话：双向时间线 = 用户投递的消息 + 每轮 Stop 的最终总结，外加还
 * 没落进事件流的在途投递行（含暂停闸成因的重发入口）。历史就是既有的事件
 * 流本身——**不落库、不复制存储**，前端翻页直接查事件（`types` 只取开/闭
 * 轮两类，不拉整条事件链），翻过的页留在组件状态里，向上滚到顶再取更早。
 * 投递无模式选择——服务端恒走 prompt 通道全自动（原生 SendMessage 中继 →
 * 终端 send-text 降级 → 未开会话积压队列），故 web 不展示也不传 mode。
 * 刷新挂 SSE 总线的 hook 订阅（开/闭轮事件 + message.*，sessionId 定向），
 * 不新开轮询。两种形态共用同一份面板：任务视图右栏嵌入（`embedded`，事件链
 * 改从头部那枚按钮开弹窗），编排画布仍是浮窗。
 */
export function SessionMessages({
  sessionId,
  projectId,
  label,
  projectLabel,
  capability,
  answerPending,
  onOpenAnswer,
  onInterrupt,
  interruptStateOf,
  minimized,
  onMinimize,
  onClose,
  embedded,
  onOpenChain,
}: {
  sessionId: string;
  /** 会话所属项目（路由锚点；会话可能采集到跨项目事件，过滤只按 sessionId）。 */
  projectId: number;
  /** 会话显示名（title 回退 sessionId 前 8 位，调用方已解好）。 */
  label: string;
  /** 项目目录名（标题副行）：跨项目同名会话只靠会话名分不清。 */
  projectLabel: string;
  /** 该会话 harness 的能力行（TasksPanel 从能力矩阵按 harness 取）。 */
  capability: MessagingCapability;
  /** 本会话被阻塞问答挂起（弹窗状态归 TasksPanel，与会话行图标/组头 tag 同一份）。 */
  answerPending?: boolean;
  /** 开作答弹窗：尾部那枚「回答」按钮（关掉不丢入口，答完待答面没了按钮随之消失）。 */
  onOpenAnswer?: () => void;
  /** 停止会话（向 pane 打一记 ESC）：与事件链组头那枚同一实现、同一 fb 键，
   *  两处按钮同转同灭。 */
  onInterrupt: (sessionId: string) => void;
  interruptStateOf: (sessionId: string) => ActionState;
  /** 挂起中（只藏不卸）：草稿与已选图片都还在，几扇对话各自独立互不影响。 */
  minimized: boolean;
  /** 挂起（浮窗限定：嵌入形态下切走由调用方置 `minimized`）。 */
  onMinimize?: () => void;
  /** 真销毁（浮窗限定：嵌入形态右栏就是这扇对话，没有关闭这回事）。 */
  onClose?: () => void;
  /** 嵌进任务视图右栏（不再套门户与蒙版、不可拖拽缩放，填满容器）。 */
  embedded?: boolean;
  /** 右上角「事件链」：把事件链开成弹窗（嵌入形态下才有这一枚）。 */
  onOpenChain?: () => void;
}) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();
  const theme = useTheme();
  /** 旁路会话弹窗（旁路历史与提问都在这扇里）。 */
  const [sideOpen, setSideOpen] = useState(false);
  const { sessions, refresh, modelCatalog } = useSessionStatus();
  const lifecycle: HarnessLifecycle = HARNESS_LIFECYCLE[capability.harness];
  // 对话数据域：翻页/SSE 增量/投递认领/贴底跟随（数据形状与刷新节奏都在 hook 里）
  const {
    filter, setFilter,
    entries, loadingEarlier,
    thread, outbox, visible, newestAssistantKey, newestQueuedId, now,
    error,
    threadRef,
    contentRef,
    stick, atBottom, lastScroll,
    status,
    compacting, interrupted, generating, failed, liveText,
    pull,
    refreshMessages,
    setMessages,
  } = useConvThread({
    sessionId,
    projectId,
    lifecycle,
    harness: capability.harness,
    answerPending: answerPending === true,
    minimized,
  });

  /** 这条此刻展开没有：手动账优先，没记过账就看是不是最新那条。 */
  const isOpen = (key: string): boolean => expanded.get(key) ?? key === newestAssistantKey;
  const toggleOpen = (key: string): void =>
    setExpanded((prev) => new Map(prev).set(key, !isOpen(key)));
  /** 本条待发的附件（上传中/已落盘/失败三态都在这一份里）；发走或关弹窗即清。 */
  const [staged, setStaged] = useState<StagedFile[]>([]);
  /** 点开的大图（缩略图点击）；null = 没开。 */
  const [lightbox, setLightbox] = useState<UploadFile | null>(null);
  /** 附件面收哪些类型（daemon 还没升级时这个字段缺席：当「不收」处理，按钮置灰
   *  而不是整扇对话崩掉）。 */
  const attachKinds = capability.attachKinds ?? [];
  /** 文件引用选择器开着（三层：父目录 | 当前目录 | 预览）；`chip` 非空 = 在改那枚胶囊。 */
  const [picker, setPicker] = useState<{ chip: HTMLElement | null; initial?: PickTarget } | null>(null);
  /** `/` 命令菜单：候选来自 harness 能力面（null = 还没取到）。`query` 是已经敲进去的
   *  那截命令名，`active` 是键盘高亮项。 */
  const [commands, setCommands] = useState<HarnessCommandRow[] | null>(null);
  /** 输入框的命令形态表（`/` 命令、claude 的 `!` bash 模式）：归 harness 能力面，
   *  随候选一起下发；web 只按 `kind` 上色，不自带触发符知识。 */
  const [inputModes, setInputModes] = useState<CommandInputModeRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 图片选择器（移动端 `accept` 收窄成相册；文件选择器不带 accept 才能选任意类型）。 */
  const imageFileRef = useRef<HTMLInputElement>(null);
  /** `/` 命令菜单容器：键盘高亮项要滚进视野。 */
  const cmdMenuRef = useRef<HTMLDivElement>(null);
  /** 全屏：面板自己铺满视口（两种形态都支持，ESC 也能退）。 */
  const [fullscreen, setFullscreen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** 切模式前先问一句：一记 Shift+Tab 就拨一格、没有反向入口，误触可能越过 plan。 */
  const [confirmMode, setConfirmMode] = useState(false);
  /** ESC 的冷却剩余秒数（0 = 可点），防连发。 */
  const [escCooldown, setEscCooldown] = useState(0);
  /** Ctrl+C 键帽的冷却剩余秒数（0 = 可点），防连发（硬中断连发没有意义）。 */
  const [ctrlCCooldown, setCtrlCCooldown] = useState(0);
  /** 手动展开/收起的账（键 → 展开）：不记 = 按「最新那条展开、更早的收起」默认。 */
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** 改动汇总弹窗（默认按轮：右键哪条气泡就看那一轮的改动；「全部对话」是逃生门）。 */
  const [editsOpen, setEditsOpen] = useState(false);
  const [editsRange, setEditsRange] = useState<{ since: string | null; until: string | null }>({
    since: null,
    until: null,
  });
  /** 队列气泡里展开看全文的那一行（多条时每行一句，点开才完整）。 */
  const [openQueued, setOpenQueued] = useState<string | null>(null);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const [inputRows, setInputRows] = useState<number>(() => {
    const v = Number(localStorage.getItem('weave:conv-input-rows'));
    return Number.isFinite(v) && v > 0
      ? Math.min(INPUT_ROWS_MAX, Math.max(INPUT_ROWS_MIN, v))
      : INPUT_ROWS_MIN;
  });
  useEffect(() => localStorage.setItem('weave:conv-input-rows', String(inputRows)), [inputRows]);
  const rowsGrip = useRef<{ y: number; rows: number } | null>(null);
  /** 发送快捷键（全局偏好）：ctrl-enter = Ctrl+Enter 发送 / Enter 换行；enter = 交换。 */
  const [sendKey, setSendKey] = useState<SendKeyMode>(sendKeyOf);
  useEffect(() => localStorage.setItem(SEND_KEY_KEY, sendKey), [sendKey]);
  const sendCombo = sendKey === 'ctrl-enter' ? 'Ctrl+Enter' : 'Enter';
  const newlineCombo = sendKey === 'ctrl-enter' ? 'Enter' : 'Ctrl+Enter';
  /** 发送钮的下拉（桌面限定：切发送/换行键序；移动端只有发送钮本体）。 */
  const [sendKeyMenu, setSendKeyMenu] = useState(false);
  const sendKeyMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sendKeyMenu) return;
    const dismiss = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-send-key-menu]')) return;
      setSendKeyMenu(false);
    };
    window.addEventListener('pointerdown', dismiss, true);
    return () => window.removeEventListener('pointerdown', dismiss, true);
  }, [sendKeyMenu]);

  /** `/` 菜单的候选：进面板取一次（目录扫描，不随每条消息重取）。
   *  失败（daemon 正在重启 / 网络抖动）不把空表钉死——退一拍重试，最多两拍；
   *  否则面板会一直「敲 / 没有候选」，只能等重挂载才自愈。 */
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const load = (attempt: number): void => {
      void api.listSessionCommands(sessionId).then(
        (r) => {
          if (!alive) return;
          setCommands(r.commands);
          setInputModes(r.inputModes ?? []);
        },
        () => {
          if (!alive) return;
          if (attempt < 2) timer = window.setTimeout(() => load(attempt + 1), 3_000);
          else setCommands([]);
        },
      );
    };
    load(0);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sessionId]);

  /** 触发符 + 名字 → 候选：胶囊颜色（skill 红 / 官方命令黄）与「句中能不能认」
   *  都按它判；同名不同触发符的两条互不覆盖。 */
  const commandInfoOf = useCallback(
    (sigil: CmdSigil, name: string): CmdInfo | undefined => {
      const hit = (commands ?? []).find((c) => c.name === name && (c.sigil ?? '/') === sigil);
      return hit ? { source: hit.source, sigil } : undefined;
    },
    [commands],
  );

  // 草稿编辑器域：contenteditable 的全部 DOM 手术与草稿持久化（hook 自持 draft 镜像）
  const {
    draft, setDraft,
    draftRef,
    cmdMenu, setCmdMenu,
    insertText, insertNewline,
    buildChip, buildCmdChip, buildAttachChip, insertAttach,
    syncCmdMenu, insertCommand, cmdMatches,
    insertRefs, insertRichText,
    closePicker, openChip, maybeOpenPicker,
    onChipDragOver, onChipDrop, onChipDragEnd, onChipDragStart,
    setDraftText,
  } = useDraftEditor({
    sessionId,
    commands,
    commandInfoOf,
    staged,
    setStaged,
    picker,
    setPicker,
  });

  /** 草稿此刻的命令形态（`!` bash 模式 / `/` 命令）：输入框据此换色——这些形态
   *  宿主自己执行、不当作 prompt 提交，发出去之前就该看得出来（claude 同款）。 */
  const draftMode = useMemo(() => commandModeOf(draft, inputModes), [draft, inputModes]);

  /** 键盘高亮项滚进视野：候选超过 max-h-56 后上下键会走出可视区。 */
  useEffect(() => {
    cmdMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cmdMenu?.active, cmdMatches]);

  // 附件暂存 + 发送队列域：选文件把关/上传/撤格，发送/出队/队列行操作
  const { stageFiles, unstage, send, queueActions } = useConvQueue({
    sessionId,
    attachKinds,
    staged,
    setStaged,
    draftRef,
    setDraft,
    setDraftText,
    insertAttach,
    stick,
    fb,
    t,
    show,
    refreshMessages,
    setMessages,
    newestQueuedId,
  });

  /** 用户编辑正文后的对账：占位与暂存格是同一条附件的两个面（1:1）——胶囊被
   *  退格/剪切/撤销删掉时，暂存格随之撤掉（反向的「撤格摘胶囊」在 unstage 里）。
   *  只挂在 onInput：程序性重写（出队回填/快照还原/发送清空）不走这里，不会把
   *  那些场景下暂时不在正文里的附件误撤掉。 */
  const reconcilePlaced = (el: HTMLDivElement): void => {
    const ids = new Set(
      Array.from(el.querySelectorAll(`[${ATTACH_ATTR}]`)).map((n) => n.getAttribute(ATTACH_ATTR) ?? ''),
    );
    for (const s of staged) {
      if (s.state === 'done' && s.upload && !ids.has(s.upload.id)) unstage(s);
    }
  };

  // 会话控制面（执行模式/模型/effort）：显示恒为「最后已知」，切换只标本地乐观态
  const {
    sessionRow, modeNames, modelNames, effortLevels,
    currentMode, contextLabel, contextPercent, modePending, modeTint,
    cycleMode, applyModel, applyEffort, modelOptions, modelValue, modelDisplay,
  } = useSessionControls({
    sessionId,
    harness: capability.harness,
    sessionRow: sessions?.find((s) => s.sessionId === sessionId),
    modelCatalog,
    fb,
    t,
    show,
    refresh,
  });

  // 浮窗几何域：尺寸/位移记忆、拖角缩放、标题栏拖动、全屏快照
  const {
    size, pos, panelRef,
    toggleFullscreen,
    onGripDown, onGripMove, onGripUp,
    onDragDown, onDragMove, onDragUp,
  } = useConvWindow({
    embedded,
    isDesktop,
    fullscreen,
    setFullscreen,
    draftRef,
    setDraft,
    buildChip,
    buildCmdChip,
    buildAttachChip,
    staged,
    threadRef,
  });

  // 多选 + 气泡手势域：勾选账、右键/双击开菜单
  const {
    selecting, setSelecting, picked, setPicked, menu, setMenu,
    enterSelect, pickedEntries, allPicked, toggleAll,
    rowProps, cancelTap,
  } = useConvSelect({ thread, coarse });

  // 分享/导出域：复制 / canvas 图片 / 单页 HTML（反馈键共用 convImg:<id>）
  const { copyPicked, shareImage, exportHtml, exportMarkdown, openShareMenu } = useConvShare({
    sessionId,
    label,
    pickedEntries,
    setMenu,
    theme,
    fb,
    t,
    show,
  });

  // Esc 逐层退：右键菜单 → 多选态 → 关闭确认 → 最小化（一层层退出，不一把关掉）。
  // 挂起中不挂这个监听：几扇对话同时存活时，只有露着的那扇该吃 ESC。
  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else if (sendKeyMenu) setSendKeyMenu(false);
      else if (selecting) {
        setSelecting(false);
        setPicked(new Set());
      } else if (confirmMode) setConfirmMode(false);
      else if (confirming) setConfirming(false);
      // 全屏优先于挂起：ESC 先把全屏退回去，再按一次才收面板
      else if (fullscreen) toggleFullscreen();
      else onMinimize?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, sendKeyMenu, selecting, confirmMode, confirming, fullscreen, minimized, onMinimize, staged]);

  // 移动端返回键/侧滑逐层退：与 ESC 同一顺序（挂起中的扇子不吃返回——只有露着
  // 的那扇该退；嵌入形态没有「挂起」这回事，恒挂）。文件选择器/大图/改动汇总/
  // 旁路会话是各自挂层的弹窗（后挂的先退），不在这条链里。
  useBackPop(!minimized, () => {
    if (menu) {
      setMenu(null);
      return true;
    }
    if (selecting) {
      setSelecting(false);
      setPicked(new Set());
      return true;
    }
    if (confirmMode) {
      setConfirmMode(false);
      return true;
    }
    if (confirming) {
      setConfirming(false);
      return true;
    }
    if (fullscreen) {
      toggleFullscreen();
      return true;
    }
    onMinimize?.();
    return true;
  });

  // ESC 键帽的冷却：一秒一格倒数，数到 0 才允许下一记。
  useEffect(() => {
    if (escCooldown <= 0) return;
    const id = window.setTimeout(() => setEscCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [escCooldown]);

  // Ctrl+C 键帽的冷却：同 ESC 口径。
  useEffect(() => {
    if (ctrlCCooldown <= 0) return;
    const id = window.setTimeout(() => setCtrlCCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [ctrlCCooldown]);

  /** 右键锚定的那条（菜单项按它的角色出）：改动汇总只对宿主回复的气泡有意义
   *  ——我方发送的气泡没有「改动」可言，菜单里不摆这一项。 */
  const menuEntry = menu?.kind === 'bubble' ? thread.find((e) => e.key === menu.key) : undefined;

  // 菜单外点一下就关（并吞掉这一下：否则同一击会顺手把整扇弹窗关掉）
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-conv-menu]')) return;
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



  /** 顶边拖拽调输入框高度：位移换行数（向上拖变高），期间只改本地态。 */
  const onRowsDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    rowsGrip.current = { y: e.clientY, rows: inputRows };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onRowsMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = rowsGrip.current;
    if (!g) return;
    const rows = g.rows + Math.round((g.y - e.clientY) / INPUT_ROW_PX);
    setInputRows(Math.min(INPUT_ROWS_MAX, Math.max(INPUT_ROWS_MIN, rows)));
  };
  const onRowsUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    rowsGrip.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };



  /** 真销毁（关）：输入框里还有未提交内容时先问一句。只有浮窗的关闭钮走这条路——
   *  ESC、最小化钮、点蒙版都走挂起，不销毁。 */
  const requestClose = (): void => {
    if (draft.trim() || staged.length > 0) setConfirming(true);
    else onClose?.();
  };

  /** 面板本体：两种形态共用（浮窗与嵌入右栏只差容器类、定位样式与是否套门户）。 */
  const body = (
      <div
        ref={panelRef}
        // 浮窗：桌面宽高跟屏幕走、拖角可改（记住）、拖标题栏可挪位；<lg 铺满可视宽。
        // 缺省高走 h-[70%]（父容器 inset-0 蒙版有确定高），size.h 拖过后行内覆盖。
        style={
          !embedded && isDesktop && !fullscreen
            ? {
                width: size.w,
                height: size.h || undefined,
                transform: pos.x || pos.y ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
              }
            : undefined
        }
        className={cn(
          'relative min-h-0 w-full flex-col overflow-hidden p-3 max-lg:pt-2',
          fullscreen
            ? // 全屏：自己铺满视口（不复用右栏/浮窗那套尺寸），z-55 在右栏之上、
              // 菜单(60)/弹窗(60-70) 之下——开菜单或看大图不会被它挡住。
              // inset-0 拉伸即可，h/w 显式视口单位在根 zoom 下被二次放大（见 index.css #root 注）
              'fixed inset-0 z-[55] flex rounded-none border-0 bg-neutral-900 shadow-none'
            : embedded
              ? // 嵌入右栏不再套卡片壳：右栏就是这扇对话，再描一圈边框只是多一道线
                // display 只给一个：hidden 与 flex 同体并列是 Tailwind 源序赌局
                cn('flex-1', minimized ? 'hidden' : 'flex')
              // 浮窗高度：桌面拖角记忆（size.h），没拖过走父容器（inset-0 蒙版）的
              // 百分比——显式 dvh 在根 zoom 下被二次放大（见 index.css #root 注）
              : 'flex h-[70%] max-lg:h-[88%] rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac',
        )}
        onClick={(e) => e.stopPropagation()}
        // 拖放面 = 整块面板（拖进任何一处都算，别让浏览器接管去打开那个文件）
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = attachedFilesFrom(e.dataTransfer);
          if (files.length > 0) stageFiles(files);
        }}
      >
        <div
          {...(embedded || fullscreen
            ? {}
            : {
                onPointerDown: onDragDown,
                onPointerMove: onDragMove,
                onPointerUp: onDragUp,
                onPointerCancel: onDragUp,
              })}
          className={cn(
            'flex items-center justify-between gap-2 pb-2 max-lg:pb-1',
            !embedded && isDesktop && !fullscreen && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {/* 与会话列表同一枚状态图标（SessionStatusIcon 唯一渲染点）：跑马灯/静态
                形/状态点三种形态都跟列表一致，不再自画 */}
            <SessionStatusIcon status={status ?? 'open'} harness={capability.harness} />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-neutral-200">
                {t('tasks.messagesTitle')} · {label}
              </p>
              <p className="truncate text-10 text-neutral-500">{projectLabel}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* 嵌入形态：事件链不再占右栏，从这枚按钮开成弹窗 */}
            {embedded && (
              <>
                {/* 旁路会话（claude 的 /btw）：能力面没有这种机制就不渲染 */}
                {capability.sideQuestion && (
                  <button
                    type="button"
                    title={t('tasks.sideTitle')}
                    aria-label={t('tasks.sideTitle')}
                    onClick={() => setSideOpen(true)}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:h-6 max-lg:w-6 max-lg:justify-center max-lg:px-0"
                  >
                    <MessageCircleQuestion className="h-3 w-3 text-violet-400" />
                    <span className="max-lg:hidden">{t('tasks.sideTitle')}</span>
                  </button>
                )}
                <button
                  type="button"
                  title={t('tasks.chainTitle')}
                  aria-label={t('tasks.chainTitle')}
                  onClick={onOpenChain}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:h-6 max-lg:w-6 max-lg:justify-center max-lg:px-0"
                >
                  <Activity className="h-3 w-3 text-rose-400" />
                  <span className="max-lg:hidden">{t('tasks.chainTitle')}</span>
                </button>
              </>
            )}
            {/* 全屏：两种形态都能用（嵌入右栏被挤窄时尤其有用）；ESC 也能退。
                样式与「事件链」同款按钮，图标用四角括线（放大 = 往外、缩小 = 往里）。 */}
            <button
              type="button"
              title={fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
              aria-label={fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
              onClick={toggleFullscreen}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:h-6 max-lg:w-6 max-lg:justify-center max-lg:px-0"
            >
              {fullscreen ? <Minimize className="h-3 w-3" /> : <Maximize className="h-3 w-3" />}
              <span className="max-lg:hidden">
                {fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
              </span>
            </button>
            {/* 嵌入形态没有挂起/关闭：右栏就是这扇对话，关掉等于把这块地方空出来 */}
            {!embedded && (
              <>
                <button
                  type="button"
                  title={t('tasks.messagesMinimize')}
                  aria-label={t('tasks.messagesMinimize')}
                  onClick={onMinimize}
                  className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={t('tasks.messagesClose')}
                  aria-label={t('tasks.messagesClose')}
                  onClick={requestClose}
                  className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* 历史过滤：只改显示，不动手上的翻页游标与勾选 */}
        <div className="flex shrink-0 items-center gap-1 pb-2 max-lg:pb-1">
          {CONV_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-10 transition-colors',
                filter === f
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                  : 'border-edge/[0.08] text-neutral-500 hover:text-neutral-300',
              )}
            >
              {f === 'all'
                ? t('tasks.convFilterAll')
                : f === 'user'
                  ? t('tasks.convFilterSent')
                  : f === 'remote'
                    ? t('tasks.convFilterRemote')
                    : capability.harness}
            </button>
          ))}
          <span className="ml-auto text-10 text-neutral-600">
            {t('tasks.convCount', { n: thread.length })}
          </span>
        </div>

        {/* 对话 = 用户投递 + 每轮 Stop 的最终总结（历史查事件流，不落库）；
            尾巴上把还没落进事件流的投递行当最新气泡摆着（Held/失败/暂停闸成因 + 重发） */}
        <div
          ref={threadRef}
          onScroll={() => {
            const el = threadRef.current;
            // 藏起来那一下的 scroll 事件（布局盒已拆、clientHeight 为 0）不算数：
            // 它会把「读到一半」误记成贴底
            if (el && el.clientHeight > 0) {
              const bottom = atBottom();
              lastScroll.current = { top: el.scrollTop, atBottom: bottom };
              stick.current = bottom;
            }
            cancelTap(); // 手指在滑 = 这一击不算轻点
            pull.syncEdge();
          }}
          onWheel={(e) => pull.wheel(e.deltaY, e.deltaMode)}
          onTouchStart={(e) => pull.touchStart(e.touches[0]?.clientY ?? 0)}
          onTouchMove={(e) => pull.touchMove(e.touches[0]?.clientY ?? 0)}
          onTouchEnd={pull.touchEnd}
          onTouchCancel={pull.touchEnd}
          className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pr-1"
        >
          {/* 拉动位移：正文整体往下让位（transform 不进布局，故不影响翻页时的滚动补偿），
              提示贴在这段空隙里跟着走 */}
          {pull.px > 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 top-1 flex justify-center"
              style={{ transform: `translateY(${pull.px}px)` }}
            >
              <span className="text-10 text-neutral-600">{t('tasks.pullMore')}</span>
            </div>
          )}
          <div
            ref={contentRef}
            className="space-y-2"
            style={pull.px > 0 ? { transform: `translateY(${pull.px}px)` } : undefined}
          >
          {entries === null ? (
            <p className="flex items-center justify-center gap-1.5 pt-6 text-xs text-neutral-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('hooks.loading')}
            </p>
          ) : thread.length === 0 && outbox.length === 0 ? (
            <p className="pt-6 text-center text-xs text-neutral-600">
              {t('tasks.messagesEmpty')}
            </p>
          ) : (
            <>
              {loadingEarlier && (
                <p className="flex items-center justify-center gap-1.5 pt-1 text-10 text-neutral-600">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('tasks.msgEarlier')}
                </p>
              )}
              {visible.length === 0 && (
                <p className="pt-6 text-center text-xs text-neutral-600">
                  {t('tasks.convFilterEmpty')}
                </p>
              )}
              {stackUnitsOf(visible, selecting).map((unit) => {
                if (unit.kind === 'group') {
                  const g = unit.group;
                  return (
                    <div key={g.key} className="group/stack">
                      <NarrationStack
                        group={g}
                        selecting={selecting}
                        coarse={coarse}
                        isOpen={isOpen}
                        toggleOpen={toggleOpen}
                      />
                    </div>
                  );
                }
                const m = unit.entry;
                if (m.role === 'compaction') {
                  // 压缩分隔：不是谁说的话，只标上下文在这里断过一次（不参与勾选）
                  return (
                    <div key={m.key} className="flex items-center gap-2 py-1 text-10 text-neutral-600">
                      <span className="h-px flex-1 bg-edge/[0.08]" />
                      <span className="shrink-0">
                        {t('hooks.mindmap.compactTag')} · {formatStamp(m.at)}
                      </span>
                      <span className="h-px flex-1 bg-edge/[0.08]" />
                    </div>
                  );
                }
                if (m.role === 'assistant') {
                  // 渲染块引用行只在最终回复出现；无引用行时 null（走原路渲染，零开销）
                  const vizSegs = m.failed ? null : hasVisualizeRef(m.text) ? visualizeSegments(m.text) : null;
                  return (
                    <div
                      key={m.key}
                      {...rowProps(m.key)}
                      className={cn(
                        // touch-manipulation：双击是我们开菜单的手势，压掉移动浏览器的双击缩放
                        'flex touch-manipulation justify-start',
                        selecting && 'select-none',
                      )}
                    >
                      {/* 长内容（markdown 里没得换行的长串）在气泡自己里面横滚，
                          不把整块对话撑出横向滚动条。过程输出单段（未成叠）与叠层
                          顶卡同款右侧滑入——实时进场的第一段也有方向感。 */}
                      <div
                        className={cn(
                          'min-w-0 max-w-[92%] overflow-x-auto rounded-lg border px-2 py-1.5',
                          m.failed
                            ? 'border-red-500/30 bg-red-950/20'
                            : 'border-edge/[0.08] bg-neutral-800/50',
                          // 被回退的段落：红虚线框 + 整体降不透明度（保留展示，一眼看出已退场）
                          m.rewound === true && 'border-dashed border-red-500/40 opacity-50',
                          m.narration === true && 'weave-card-in',
                        )}
                      >
                        <span className="mb-0.5 flex items-center gap-1.5 text-10 text-neutral-600">
                          {formatStamp(m.at)}
                          {m.plan === true && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-10 font-medium text-amber-300">
                              {t('tasks.convPlan')}
                            </span>
                          )}
                          {m.preQuestion === true && (
                            <span className="shrink-0 rounded bg-sky-500/15 px-1 py-px text-10 font-medium text-sky-300">
                              {t('tasks.convPreQuestion')}
                            </span>
                          )}
                          {m.narration === true && (
                            <span className="shrink-0 rounded bg-neutral-500/15 px-1 py-px text-10 font-medium text-neutral-400">
                              {t('tasks.convNarration')}
                            </span>
                          )}
                          {m.rewound === true && (
                            <span className="shrink-0 rounded bg-red-500/15 px-1 py-px text-10 font-medium text-red-300">
                              {t('tasks.convRewound')}
                            </span>
                          )}
                        </span>
                        {/* 宿主报的错不是回答：不排 markdown（原文就是一行技术串），
                            一律红字——系统错误得和正文一眼分得开 */}
                        {m.failed ? (
                          <p className="flex items-start gap-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-red-300">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            {m.text}
                          </p>
                        ) : (
                          <Collapsible
                            text={m.text}
                            open={isOpen(m.key)}
                            onToggle={() => toggleOpen(m.key)}
                            disabled={selecting}
                          >
                            {/* markdown 段落里的单 \n（软换行）要显示成换行：
                                不加 pre-wrap 会被 HTML 空白折叠并成空格（与
                                user 气泡同款包装）。带渲染块引用行时按段切：
                                引用行整行换成 sandbox iframe，其余照常 markdown。 */}
                            {vizSegs ? (
                              <VizSegments
                                segments={vizSegs}
                                markdown={(text) => <AssistantMarkdown text={text} />}
                              />
                            ) : (
                              <div className="[&_p]:whitespace-pre-wrap">
                                <AssistantMarkdown text={m.text} />
                              </div>
                            )}
                          </Collapsible>
                        )}
                      </div>
                      {selecting && <CheckBox on={picked.has(m.key)} className="ml-1.5 mt-1" />}
                    </div>
                  );
                }
                const pipe = m.pipe;
                // 官方命令只在句首生效；skill/插件可以插在句中（前后须是空白）
                const cmdTokens = commandTokensOf(m.text, commandInfoOf);
                // 带图条目按 `[Image #N]` 占位记号把图内联回原位置；被内联的图
                // 不再进预览行（一张图只出现一次），记号比图少时多出来的图与
                // 全部文件行仍归预览行（老消息没有记号 → 图全留预览行）。
                // **web 发的（有投递行）优先按投递行原文的路径位置切段**：宿主
                // 粘贴处理把记号聚到消息开头，会话侧正文已丢位置；投递行存的
                // 用户原文里位置完好（占位胶囊原地展开），按它切才回得去。
                const inlineSegs =
                  m.role === 'user' && m.attachments?.some(isImageUpload)
                    ? (pipe && pipePathSegments(pipe.text, m.attachments.filter(isImageUpload))) ??
                      imageMarkerSegments(m.text, m.attachments.filter(isImageUpload))
                    : null;
                const inlinedIds = new Set<string>();
                for (const s of inlineSegs ?? []) if (s.kind === 'image') inlinedIds.add(s.image.id);
                const previewAtts = (m.attachments ?? []).filter(
                  (a) => !isImageUpload(a) || !inlinedIds.has(a.id),
                );
                return (
                  <div
                    key={m.key}
                    {...rowProps(m.key)}
                    className={cn(
                      // touch-manipulation：同助手气泡，双击开菜单不触发双击缩放
                      'flex touch-manipulation items-end justify-end gap-1',
                      selecting && 'select-none',
                    )}
                  >
                    {selecting && <CheckBox on={picked.has(m.key)} className="mr-1.5 mt-1" />}
                    {/* 气泡色分两侧：**回复（左）走中性灰、发送（右）走蓝**，一眼分得开；
                        同一侧再按投递来源分深浅——weave 投递的深一点，终端里手敲的浅一点
                        （tag/回执点另说，那两样才是「投递成功与否」） */}
                    <div
                      className={cn(
                        'min-w-0 max-w-[85%] overflow-x-auto rounded-lg border px-2 py-1.5',
                        pipe
                          ? 'border-blue-500/30 bg-blue-500/[0.12]'
                          : 'border-blue-500/15 bg-blue-500/[0.05]',
                        // 被回退的段落：红虚线框 + 整体降不透明度（与回复气泡同口径）
                        m.rewound === true && 'border-dashed border-red-500/40 opacity-50',
                      )}
                    >
                      {/* 时刻与左侧回复气泡同布局：气泡上部、靠屏幕边缘那一侧
                          （这里右对齐），weave 来源 tag 与投递状态徽标和它并排 */}
                      <div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {m.rewound === true && (
                          <span className="shrink-0 rounded bg-red-500/15 px-1 py-px text-10 font-medium text-red-300">
                            {t('tasks.convRewound')}
                          </span>
                        )}
                        {m.fromWeave && (
                          <span className="shrink-0 rounded bg-blue-500/15 px-1 py-px text-10 font-medium text-blue-300">
                            weave
                          </span>
                        )}
                        {/* 不是 weave 发的会话间消息（别的会话用 CC 自己的 SendMessage）：
                            挂发送方会话名，与终端里手敲的 prompt 区分开 */}
                        {isRemotePrompt(m) && (
                          <span className="shrink-0 rounded border border-edge/[0.12] px-1 py-px text-10 text-neutral-400">
                            {m.fromName}
                          </span>
                        )}
                        {pipe !== undefined && pipe.status !== 'delivered' && (
                          <Badge className={cn('shrink-0', STATUS_BADGE[pipe.status])}>
                            {t(STATUS_KEY[pipe.status])}
                          </Badge>
                        )}
                        {pipe?.stalled === true && (
                          <span className="shrink-0 text-10 text-amber-400">
                            {t('tasks.msgStalled')}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-10 text-neutral-600">
                          {formatStamp(m.at)}
                        </span>
                      </div>
                      {/* 随附文件：图出缩略图（点开大图），其余出可下载的文件行。
                          已按记号内联回正文的图不重复摆（见上方 inlineSegs）。 */}
                      {previewAtts.length ? (
                        <div className="mb-1 flex flex-wrap items-start gap-1.5">
                          {previewAtts.map((a) =>
                            isImageUpload(a) ? (
                              <button
                                key={a.id}
                                type="button"
                                title={a.name}
                                onClick={(e) => {
                                  if (selecting) return;
                                  e.stopPropagation();
                                  setLightbox(a);
                                }}
                                className="block h-14 w-14 overflow-hidden rounded border border-edge/[0.12] bg-neutral-950"
                              >
                                <img
                                  // 走 API_BASE：dev 由 vite 代理剥离 /api，裸 /images 会被 SPA 回退成 index.html
                                  src={`${API_BASE}/images/${a.id}`}
                                  alt={a.name}
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                />
                              </button>
                            ) : (
                              <a
                                key={a.id}
                                href={`${API_BASE}/images/${a.id}`}
                                download={a.name}
                                title={[a.name, sizeLabel(a.size ?? 0)].filter(Boolean).join(' · ')}
                                onClick={(e) => {
                                  if (selecting) {
                                    e.preventDefault();
                                    return;
                                  }
                                  e.stopPropagation();
                                }}
                                className="inline-flex max-w-full items-center gap-1 rounded border border-edge/[0.12] bg-neutral-950 px-1.5 py-1 text-10 text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300"
                              >
                                <FileCode className="h-3 w-3 shrink-0" />
                                <span className="min-w-0 truncate">{a.name}</span>
                              </a>
                            ),
                          )}
                        </div>
                      ) : null}
                      {/* 斜杠命令画成胶囊（skill 红 / 官方命令黄，参数照常当文字）；
                          其余走 markdown 预览（与左侧回复气泡同渲染器），
                          `pre-wrap` 保住段落里的软换行。带图条目按 `[Image #N]`
                          占位记号把图内联回去（内联了的不再进预览行）。记号位置
                          是宿主给的——恒聚在消息开头（粘贴处理器先插记号后插
                          剩余文本，都落在光标点），气泡照实渲染。 */}
                      {inlineSegs ? (
                        <div className="flex flex-col gap-1 [&_p]:whitespace-pre-wrap">
                          {inlineSegs.map((seg, i) =>
                            seg.kind === 'image' ? (
                              <button
                                key={i}
                                type="button"
                                title={seg.image.name}
                                onClick={(e) => {
                                  if (selecting) return;
                                  e.stopPropagation();
                                  setLightbox(seg.image);
                                }}
                                className="block h-20 w-20 overflow-hidden rounded border border-edge/[0.12] bg-neutral-950"
                              >
                                <img
                                  src={`${API_BASE}/images/${seg.image.id}`}
                                  alt={seg.image.name}
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                />
                              </button>
                            ) : seg.text.trim() ? (
                              <AssistantMarkdown key={i} text={seg.text} />
                            ) : null,
                          )}
                        </div>
                      ) : cmdTokens.some((tok) => 'cmd' in tok) || m.commandOutput ? (
                        <div className="flex flex-col gap-1">
                          <p className="flex flex-wrap items-baseline whitespace-pre-wrap break-words text-xs leading-relaxed">
                            {cmdTokens.map((tok, i) =>
                              'cmd' in tok ? (
                                <span key={i} className={cmdChipClass(tok.source)}>
                                  {`${tok.sigil}${tok.cmd}`}
                                </span>
                              ) : (
                                <span key={i}>{tok.text}</span>
                              ),
                            )}
                          </p>
                          {/* 内建命令的宿主回显（转录里的 local-command-stdout） */}
                          {m.commandOutput && (
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950/70 px-1.5 py-1 font-mono text-10 leading-4 text-neutral-400">
                              {m.commandOutput}
                            </pre>
                          )}
                        </div>
                      ) : (
                        <div className="[&_p]:whitespace-pre-wrap">
                          <AssistantMarkdown text={m.text} />
                        </div>
                      )}
                      {/* 判死落定（会话进程不在）：说人话，别把英文技术串端上来 */}
                      {pipe?.reason === 'offline' ? (
                        <p className="mt-1 break-words text-11 text-amber-400">
                          {t('tasks.msgOffline')}
                        </p>
                      ) : (
                        pipe?.error && (
                          <p className="mt-1 break-words text-11 text-red-400">{pipe.error}</p>
                        )
                      )}
                      {/* 多选态里重发/删除不渲染——它们会跟「点气泡即勾选」抢点击。
                          这条已经落进对话了，按钮只对「还没成真」的状态有意义（已送达的
                          行要删去队列尾巴上删，这里的删除会留一条删不掉的气泡） */}
                      {!selecting &&
                        pipe &&
                        (pipe.status === 'failed' || pipe.status === 'pending' || pipe.stalled === true) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {(pipe.status === 'failed' || pipe.stalled === true) && (
                            <button
                              type="button"
                              disabled={fb.stateOf(`resend:${pipe.id}`) === 'loading'}
                              onClick={() =>
                                void fb.run(
                                  `resend:${pipe.id}`,
                                  async () => {
                                    await api.resendSessionMessage(sessionId, pipe.id);
                                    await refreshMessages();
                                  },
                                  { fail: (e) => t('tasks.msgResendFailed', { error: errorText(e) }) },
                                )
                              }
                              className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-950/30 px-1.5 py-0.5 text-10 text-amber-300 transition-colors hover:border-amber-500/50 disabled:opacity-40"
                            >
                              <FeedbackIcon
                                state={fb.stateOf(`resend:${pipe.id}`)}
                                className="h-3 w-3"
                                icon={<RotateCcw className="h-3 w-3" />}
                              />
                              {t('tasks.msgResend')}
                            </button>
                          )}
                          {/* 删除：这条从对话里彻底消失（是暂停闸成因时一并解闸并续排空；
                              还在队列里的 pending 行则是取消发送） */}
                          <button
                            type="button"
                            title={t(
                              pipe.status === 'pending'
                                ? 'tasks.msgDismissQueuedHint'
                                : 'tasks.msgDismissHint',
                            )}
                            disabled={fb.stateOf(`dismiss:${pipe.id}`) === 'loading'}
                            onClick={() =>
                              void fb.run(
                                `dismiss:${pipe.id}`,
                                async () => {
                                  await api.dismissSessionMessage(sessionId, pipe.id);
                                  await refreshMessages();
                                },
                                { fail: (e) => t('tasks.msgDismissFailed', { error: errorText(e) }) },
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200 disabled:opacity-40"
                          >
                            <FeedbackIcon
                              state={fb.stateOf(`dismiss:${pipe.id}`)}
                              className="h-3 w-3"
                              icon={<Trash2 className="h-3 w-3" />}
                            />
                            {t('tasks.msgDismiss')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* 发送队列 = 尾巴上的「最新几条」：还没落进事件流的行（排队/在飞/已发出
                  未回执/失败/被闸住）就摆在它将来会出现的位置上等。多条收进同一个气泡、
                  每行一句（点开看全文），操作纯图标常显在右。虚线边框标「还没落定」——
                  认领即退场，真气泡接手时位置不变。 */}
              {!selecting && outbox.length > 0 && (
                <div className="flex flex-col items-end gap-1">
                  {/* 模态框在场时层② 不盲注：这些行只能等作答完成（服务端判据同上）。 */}
                  {answerPending && (
                    <p className="max-w-[95%] text-right text-10 text-amber-300">
                      {t('tasks.outboxBlockedByQuestion')}
                    </p>
                  )}
                  <div className="min-w-0 max-w-[95%] overflow-x-auto rounded-lg border border-dashed border-blue-500/30 bg-blue-500/[0.07] px-2 py-1.5">
                    {outbox.map((m, i) => {
                      const open = outbox.length === 1 || openQueued === m.id;
                      const toggle = (): void => {
                        if (outbox.length > 1) setOpenQueued((id) => (id === m.id ? null : m.id));
                      };
                      return (
                        <div
                          key={`q:${m.id}`}
                          className={cn(
                            'flex gap-1.5',
                            open ? 'items-start' : 'items-center',
                            i > 0 && 'mt-1 border-t border-blue-500/10 pt-1',
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            {open ? (
                              <div
                                onClick={toggle}
                                className={cn(
                                  'mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5',
                                  outbox.length > 1 && 'cursor-pointer',
                                )}
                              >
                                <Badge className={cn('shrink-0', STATUS_BADGE[m.status])}>
                                  {t(queueStatusKey(m))}
                                </Badge>
                                {m.stalled === true && (
                                  <span className="shrink-0 text-10 text-amber-400">
                                    {t('tasks.msgStalled')}
                                  </span>
                                )}
                                {/* 闸会自己放掉这条（服务端时刻），倒计时是给人看清还剩多久的 */}
                                {m.stalled === true && m.releaseAt != null && (
                                  <span className="shrink-0 text-10 text-neutral-500">
                                    {t('tasks.msgClearIn', {
                                      left: countdownLabel(m.releaseAt, now),
                                    })}
                                  </span>
                                )}
                                {m.attachments?.length ? (
                                  <Paperclip className="h-3 w-3 shrink-0 text-neutral-500" />
                                ) : null}
                                <span className="ml-auto shrink-0 text-10 text-neutral-600">
                                  {formatStamp(m.at)}
                                </span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                title={m.text}
                                onClick={toggle}
                                className="flex w-full min-w-0 items-center gap-1.5 text-left"
                              >
                                <Badge className={cn('shrink-0', STATUS_BADGE[m.status])}>
                                  {t(queueStatusKey(m))}
                                </Badge>
                                {m.stalled === true && (
                                  <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                                )}
                                {m.attachments?.length ? (
                                  <Paperclip className="h-3 w-3 shrink-0 text-neutral-500" />
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-12 text-neutral-200">
                                  {m.text || m.attachments?.[0]?.name}
                                </span>
                                <span className="shrink-0 text-10 text-neutral-600">
                                  {formatStamp(m.at)}
                                </span>
                              </button>
                            )}
                            {open && (
                              <>
                                <div className="whitespace-pre-wrap break-words text-12 text-neutral-200">
                                  {m.text || m.attachments?.[0]?.name}
                                </div>
                                {m.attachments?.length ? (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {m.attachments.map((a) => (
                                      <span
                                        key={a.id}
                                        className="inline-flex max-w-full items-center gap-1 rounded border border-edge/[0.12] px-1 py-0.5 text-10 text-neutral-400"
                                      >
                                        <Paperclip className="h-2.5 w-2.5 shrink-0" />
                                        <span className="min-w-0 truncate">{a.name}</span>
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                                {/* 判死落定（会话进程不在）：说人话，别把英文技术串端上来 */}
                                {m.reason === 'offline' ? (
                                  <p className="mt-1 break-words text-11 text-amber-400">
                                    {t('tasks.msgOffline')}
                                  </p>
                                ) : m.error ? (
                                  <p className="mt-1 break-words text-11 text-red-400">
                                    {m.error}
                                  </p>
                                ) : null}
                              </>
                            )}
                          </div>
                          <div className={cn('flex shrink-0 items-center gap-1', open && 'pt-0.5')}>
                            {queueActions(m)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(answerPending || generating || interrupted) && (
                <div className="flex flex-wrap items-center justify-start gap-1.5">
                  {answerPending && (
                    <button
                      type="button"
                      title={t('tasks.answerTooltip')}
                      onClick={() => onOpenAnswer?.()}
                      className="flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-10 font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:text-amber-200"
                    >
                      <HelpCircle className="h-3 w-3" />
                      {t('tasks.convAnswer')}
                    </button>
                  )}
                  {(generating || interrupted || failed) && (
                    <div
                      className={cn(
                        'flex min-w-0 grow basis-48 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-10',
                        failed
                          ? 'border-red-500/30 bg-red-950/30 text-red-300'
                          : 'border-edge/[0.08] bg-neutral-800/50 text-neutral-500',
                      )}
                    >
                      {interrupted ? (
                        <Ban className="h-3 w-3 shrink-0" />
                      ) : failed ? (
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                      ) : (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      )}
                      {interrupted ? (
                        t('tasks.msgInterrupted')
                      ) : failed ? (
                        <span className="min-w-0 truncate" title={failed.text}>
                          {failed.text}
                        </span>
                      ) : compacting ? (
                        t('tasks.msgCompacting')
                      ) : liveText ? (
                        <EventTicker text={liveText} />
                      ) : (
                        t('tasks.msgGenerating')
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          </div>
        </div>

        {error && (
          <p className="mt-1 shrink-0 rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-11 text-red-300">
            {error}
          </p>
        )}

        {/* 多选态：composer 换成工具条（投递与挑选是两件事，不并排摆）。窄屏放不下
            就整组折到第二行——按钮不等宽也不做横向滚动 */}
        {selecting ? (
          <div className="mt-2 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 max-lg:border-t max-lg:border-edge/[0.08] max-lg:pt-2">
            <span className="min-w-0 truncate text-11 text-neutral-400">
              {t('tasks.convSelected', { n: picked.size })}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={thread.length === 0}
                onClick={toggleAll}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-11 transition-colors disabled:opacity-40',
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
                onClick={copyPicked}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-200 transition-colors hover:border-edge/20 disabled:opacity-40"
              >
                <Copy className="h-3 w-3" />
                {t('tasks.convCopy')}
              </button>
              <button
                type="button"
                disabled={picked.size === 0}
                onClick={openShareMenu}
                title={t('tasks.convShare')}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-200 transition-colors hover:border-edge/20 disabled:opacity-40"
              >
                <FeedbackIcon
                  state={fb.stateOf(`convImg:${sessionId}`)}
                  className="h-3 w-3"
                  icon={<ImageIcon className="h-3 w-3" />}
                />
                {t('tasks.convShare')}
                {/* 下拉的箭头：菜单是往上弹的，箭头朝上；展开时翻过来 */}
                <ChevronUp
                  className={cn(
                    'h-3 w-3 shrink-0 text-neutral-500 transition-transform',
                    menu?.kind === 'share' && 'rotate-180',
                  )}
                />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelecting(false);
                  setPicked(new Set());
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200"
              >
                {t('tasks.convCancel')}
              </button>
            </div>
          </div>
        ) : (
          /* Composer：无模式选择（服务端恒 prompt 通道全自动）；发送键旁的箭头
             只选**投递通道**（自动 / 强制终端），不是 inject/headless 那套模式。
             层①② 皆无的 harness 才置灰，理由取能力矩阵 unsupportedReasons.prompt。
             会话控制面（执行模式 / 模型）收在输入框正上方的**一条控制行**里——
             两者切换都不留 hook 痕迹（Shift+Tab 一个事件都不发、/model 不落盘），
             故标注是「最后已知」而非此刻。宿主只有「切一档」没有定点设模式，故
             模式做成按钮（点 = Shift+Tab 一档）；模型有 `/model <名>`，做成下拉。
             **图片上传对齐位**：附件钮 + 预览缩略图居左，模式/模型居右（`ml-auto`），
             放不下即折行；别占到输入行与发送键那两格去。 */
          <div className="mt-2 flex shrink-0 flex-col gap-1.5 max-lg:mt-1 max-lg:gap-1 max-lg:border-t max-lg:border-edge/[0.08] max-lg:pt-1.5">
            {/* 控制行（一条）：图片居左、模式/模型居右，放不下即折行（不做横向滚动）。 */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* 附件钮（图片/文件两枚）+ 两个预览区（图片区 / 文件区各自一段，
                  <lg 各占一行、lg 起同行自适应折行）。粘贴/拖放也走同一份 staged
                  ——三条入口，一份状态；文件格不预览，只摆图标 + 上传进度。 */}
              {/* 不挂 flex-1：`flex: 1 1 0%` 的基准是 0，换行判定时它永远「放得下」→
                  右组从不折行，左组被压到 0 宽、里面的附件钮溢出去盖在模式/模型上。
                  让左组按内容占位，放不下时父级的 flex-wrap 才会把右组挪到下一行。 */}
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 max-lg:contents">
                {/* 图片选择器：`accept` 收窄成相册（移动端相册直开）；文件选择器
                    显式 accept 星斜杠星——部分安卓内核（微信 X5 等）对不带 accept
                    的输入框只给「图片/相机」，写了才会弹系统文件管理器（任意类型）。 */}
                <input
                  ref={imageFileRef}
                  type="file"
                  accept={IMAGE_TYPES.join(',')}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) stageFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="*/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) stageFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  disabled={!attachKinds.includes('image') || staged.length >= ATTACH_MAX_COUNT}
                  title={
                    attachKinds.includes('image')
                      ? t('tasks.msgAttachImageHint')
                      : (capability.unsupportedReasons?.prompt ?? t('tasks.msgAttachUnsupported'))
                  }
                  aria-label={t('tasks.msgAttachImage')}
                  onClick={() => imageFileRef.current?.click()}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:h-6 max-lg:w-6 max-lg:justify-center max-lg:px-0"
                >
                  <ImageIcon className="h-3 w-3" />
                  <span className="max-lg:hidden">{t('tasks.msgAttachImage')}</span>
                </button>
                <button
                  type="button"
                  disabled={!attachKinds.includes('file') || staged.length >= ATTACH_MAX_COUNT}
                  title={
                    attachKinds.includes('file')
                      ? t('tasks.msgAttachFileHint')
                      : (capability.unsupportedReasons?.prompt ?? t('tasks.msgAttachUnsupported'))
                  }
                  aria-label={t('tasks.msgAttachFile')}
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:h-6 max-lg:w-6 max-lg:justify-center max-lg:px-0"
                >
                  {staged.some((s) => !isImageUpload(s) && s.state === 'uploading') ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Paperclip className="h-3 w-3" />
                  )}
                  <span className="max-lg:hidden">{t('tasks.msgAttachFile')}</span>
                </button>
                {/* 引用文件（@ 路径引用选择器）：与上传是两扇门——它插的是项目内
                    文件的引用胶囊，不占附件格。 */}
                <button
                  type="button"
                  disabled={!capability.pathRefs}
                  title={
                    capability.pathRefs
                      ? t('tasks.fileAttachHint')
                      : (capability.unsupportedReasons?.pathRefs ?? t('tasks.fileUnsupported'))
                  }
                  aria-label={t('tasks.fileAttach')}
                  onClick={() => setPicker({ chip: null })}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:h-6 max-lg:w-6 max-lg:justify-center max-lg:px-0"
                >
                  <FileCode className="h-3 w-3" />
                  <span className="max-lg:hidden">{t('tasks.fileAttach')}</span>
                </button>
                {/* 两个预览区：<lg 各占一行（basis-full），lg 起同行自适应折行。
                    没有暂存件时整块不渲染——空的 `basis-full` 照样占满一行，
                    会把右侧「模式/模型」挤到下一行去（移动端每多一行都是从气泡区挤的）。 */}
                {staged.length > 0 && (
                  <div className="flex min-w-0 basis-full flex-wrap items-center gap-1.5 lg:basis-auto">
                    <StagedRow label={t('tasks.msgAttachImage')} items={staged.filter(isImageUpload)}>
                      {staged
                        .filter(isImageUpload)
                        .map((item) => (
                          <StagedTile
                            key={item.key}
                            item={item}
                            onOpen={setLightbox}
                            onRemove={() => unstage(item)}
                            removeLabel={t('tasks.msgAttachRemove')}
                          />
                        ))}
                    </StagedRow>
                    <StagedRow label={t('tasks.msgAttachFile')} items={staged.filter((s) => !isImageUpload(s))}>
                      {staged
                        .filter((s) => !isImageUpload(s))
                        .map((item) => (
                          <StagedTile
                            key={item.key}
                            item={item}
                            onOpen={setLightbox}
                            onRemove={() => unstage(item)}
                            removeLabel={t('tasks.msgAttachRemove')}
                          />
                        ))}
                    </StagedRow>
                  </div>
                )}
              </div>
              {(modeNames.length > 0 || modelNames.length > 0) && (
                <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 max-lg:contents">
                  {modeNames.length > 0 && (
                    <button
                      type="button"
                      title={t('tasks.modeCycle')}
                      aria-label={t('tasks.modeCycle')}
                      onClick={() => setConfirmMode(true)}
                      className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 transition-colors hover:border-blue-500/40"
                    >
                      <FeedbackIcon
                        state={fb.stateOf(`cycleMode:${sessionId}`)}
                        className="h-3 w-3 text-neutral-500"
                        icon={<RotateCcw className="h-3 w-3" />}
                      />
                      <span className="shrink-0 text-10 text-neutral-500">
                        {t('tasks.modeLabel')}
                      </span>
                      <span
                        title={
                          modePending !== null
                            ? t('tasks.modeSwitchingHint')
                            : (currentMode ?? t('tasks.modeLastKnown'))
                        }
                        style={{ color: modeTint ?? undefined }}
                        className={cn(
                          'truncate font-mono text-11 max-lg:max-w-[6rem]',
                          !modeTint && 'text-neutral-400',
                        )}
                      >
                        {modePending !== null
                          ? t('tasks.modeSwitching')
                          : (currentMode ?? t('tasks.modeUnknown'))}
                      </span>
                    </button>
                  )}
                  {modelNames.length > 0 && (
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0 text-10 text-neutral-500">
                        {t('tasks.modelLabel')}
                      </span>
                      <div className="relative min-w-0">
                        <Combobox
                          value={modelValue}
                          onChange={(v) => {
                            if (v) applyModel(v);
                          }}
                          title={t('tasks.modelLastKnown')}
                          placeholder={t('tasks.modelUnknown')}
                          className="max-w-[12rem] rounded border border-edge/[0.1] bg-neutral-950 py-0.5 font-mono text-11 max-lg:max-w-[7rem]"
                          options={[
                            ...modelOptions,
                            // 认不出别名的真名（别名表缺配）也得能显示成选中
                            ...(modelValue && !modelOptions.some((o) => o.value === modelValue)
                              ? [{ value: modelValue }]
                              : []),
                          ]}
                        />
                      </div>
                    </div>
                  )}
                  {effortLevels.length > 0 && (
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0 text-10 text-neutral-500">
                        {t('tasks.effortLabel')}
                      </span>
                      <EnumSlider
                        levels={effortLevels}
                        value={sessionRow?.effort ?? null}
                        title={t('tasks.effortLastKnown')}
                        onCommit={applyEffort}
                      />
                    </div>
                  )}
                  {contextLabel !== null && (
                    <span
                      title={t('tasks.contextLastKnown')}
                      className="flex shrink-0 items-center gap-1.5 font-mono text-11 text-neutral-400 max-lg:ml-auto"
                    >
                      {contextLabel}
                      {/* 迷你进度条：同一读数按窗口档位折成的百分比（200k/1M 两档） */}
                      <span className="h-1 w-10 overflow-hidden rounded-full bg-neutral-800">
                        <span
                          className={`block h-full rounded-full ${
                            (contextPercent ?? 0) >= 80
                              ? 'bg-red-500/80'
                              : (contextPercent ?? 0) >= 60
                                ? 'bg-amber-500/80'
                                : 'bg-emerald-500/70'
                          }`}
                          style={{ width: `${Math.max(2, contextPercent ?? 0)}%` }}
                        />
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* 顶边拖拽手柄：贴在两行之间，负边距吃掉 gap，免得常显多出一条空隙。
                触屏同样可用（pointer capture + touch-none；手柄自身不吃滚动，
                旁边的对话区照常滚）。 */}
            <div
              role="separator"
              title={t('tasks.msgResizeInput')}
              aria-label={t('tasks.msgResizeInput')}
              onPointerDown={onRowsDown}
              onPointerMove={onRowsMove}
              onPointerUp={onRowsUp}
              onPointerCancel={onRowsUp}
              className="group -mb-1 flex h-2 cursor-ns-resize touch-none items-center justify-center max-lg:h-4"
            >
              <span className="h-0.5 w-8 rounded-full bg-edge/[0.12] transition-colors group-hover:bg-blue-500/50 max-lg:w-12" />
            </div>
            <div className="flex flex-wrap items-end gap-1.5">
              {/* 输入框是 contenteditable 而非 textarea：内联引用胶囊必须是
                  `contenteditable=false` 的原子块（退格整枚删、光标进不去），
                  textarea 里塞不了元素。高度仍按行数算（顶边可拖），换行靠自己
                  插——浏览器 Enter 那套会给出 `<div>`，序列化就不干净了。 */}
              <div className="relative min-w-0 flex-1 max-lg:basis-full">
                {draft === '' && (
                  <span className="pointer-events-none absolute left-2 top-1.5 text-xs text-neutral-600">
                    {t('tasks.messagesPlaceholder', { send: sendCombo, newline: newlineCombo })}
                  </span>
                )}
                {/* `/` 命令提示：候选归 harness 能力面，这里只筛与渲染 */}
                {cmdMenu && cmdMatches.length > 0 && (
                  <div
                    ref={cmdMenuRef}
                    data-cmd-menu
                    className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-edge/[0.1] bg-neutral-900 py-1 shadow-mac"
                  >
                    {cmdMatches.map((c, i) => (
                      <button
                        key={c.name}
                        type="button"
                        aria-selected={i === cmdMenu.active}
                        // 用 mousedown 落定：click 之前焦点已经离开 composer，光标就没了
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insertCommand(c.name, c.sigil ?? '/');
                        }}
                        className={cn(
                          'flex w-full items-baseline gap-2 px-2 py-1 text-left',
                          i === cmdMenu.active ? 'bg-edge/[0.08]' : 'hover:bg-edge/[0.06]',
                        )}
                      >
                        <span className={cmdChipClass(c.source)}>{`${c.sigil ?? '/'}${c.name}`}</span>
                        {c.argsHint && (
                          <span className="shrink-0 font-mono text-10 text-neutral-500">{c.argsHint}</span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-10 text-neutral-500">
                          {c.description}
                        </span>
                        <span className="shrink-0 text-9 text-neutral-600">
                          {t(`tasks.cmdSource_${c.source}` as 'tasks.cmdSource_builtin')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div
                  ref={draftRef}
                  role="textbox"
                  aria-multiline="true"
                  aria-label={t('tasks.messagesPlaceholder')}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(e) => {
                    if (maybeOpenPicker(e.currentTarget, e.nativeEvent as InputEvent)) return;
                    setDraft(serializeDraft(e.currentTarget));
                    syncCmdMenu(e.currentTarget);
                    reconcilePlaced(e.currentTarget);
                  }}
                  onClick={(e) => {
                    // 点胶囊：引用 = 改这枚引用；附件占位 = 开大图预览
                    // （胶囊是原子块，点它不会落光标）
                    const target = e.target as HTMLElement | null;
                    const chip = target?.closest?.(`[${REF_ATTR}]`);
                    if (chip instanceof HTMLElement) {
                      openChip(chip);
                      return;
                    }
                    const att = target?.closest?.(`[${ATTACH_ATTR}]`);
                    if (att instanceof HTMLElement) {
                      const id = att.getAttribute(ATTACH_ATTR) ?? '';
                      const upload = staged.find((s) => s.upload?.id === id)?.upload;
                      if (upload) setLightbox(upload);
                    }
                  }}
                  onKeyDown={(e) => {
                    // 输入法组字中的 Enter 是「确认候选词」，不是发送
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    // `/` 菜单开着时键盘归它：上下选、Enter/Tab 落定、ESC 收起
                    if (cmdMenu && cmdMatches.length > 0) {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const step = e.key === 'ArrowDown' ? 1 : -1;
                        setCmdMenu((m) =>
                          m ? { ...m, active: (m.active + step + cmdMatches.length) % cmdMatches.length } : m,
                        );
                        return;
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        const pick = cmdMatches[cmdMenu.active] ?? cmdMatches[0]!;
                        insertCommand(pick.name, pick.sigil ?? '/');
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setCmdMenu(null);
                        return;
                      }
                    }
                    // 发送/换行的键序随全局偏好（发送键旁那枚钮可交换）
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) === (sendKey === 'ctrl-enter')) {
                      e.preventDefault();
                      send();
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      insertText('\n');
                    }
                  }}
                  onPaste={(e) => {
                    // 只在真取到文件时才压默认：粘贴文字走纯文本
                    const files = attachedFilesFrom(e.clipboardData);
                    if (files.length > 0) {
                      e.preventDefault();
                      stageFiles(files);
                      return;
                    }
                    // 一律走纯文本：粘进来的 HTML 会把样式和结构一起带进 DOM，
                    // 序列化就再也吐不回一句干净的话。文本里的引用表达式认得出
                    // 就落成胶囊（那本来就是它发出去时的样子）
                    const text = e.clipboardData.getData('text/plain');
                    if (text) {
                      e.preventDefault();
                      insertRichText(text);
                    }
                  }}
                  onDragOver={onChipDragOver}
                  onDrop={onChipDrop}
                  onDragEnd={onChipDragEnd}
                  onDragStart={onChipDragStart}
                  style={{ height: `calc(${inputRows * INPUT_ROW_PX}px + 0.75rem)` }}
                  className={cn(
                    'w-full overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded border bg-neutral-950 px-2 py-1.5 text-xs leading-4 text-neutral-100 focus:outline-none',
                    draftMode
                      ? commandModeClass(draftMode)
                      : 'border-edge/[0.1] focus:border-blue-500/40',
                  )}
                />
              </div>
              {/* 换行：只在窄屏露面（桌面有 Shift+Enter）；触屏没有修饰键这一说。
                  用文字不用图标——Enter 键帽已占了 CornerDownLeft，再摆一枚同形的
                  就是两个一样的箭头。`pointerdown` 压掉默认 = 不把焦点从输入框抢走
                  （抢了软键盘会收）。 */}
              <button
                type="button"
                title={t('tasks.msgNewline')}
                aria-label={t('tasks.msgNewline')}
                onPointerDown={(e) => e.preventDefault()}
                onClick={insertNewline}
                className="hidden shrink-0 items-center justify-center rounded border border-edge/[0.1] px-2 text-10 text-neutral-400 transition-colors hover:border-blue-500/40 hover:text-blue-300 max-lg:inline-flex max-lg:h-6"
              >
                {t('tasks.msgNewline')}
              </button>
              {/* 停止 / 发送（+ 通道下拉）：靠右。窄屏输入框独占一行、这三枚钮折到
                  第二行靠右（`ml-auto`，与左边那枚换行分开拇指够得到的两头）；
                  桌面并排一行。停止与事件链组头同一判据与 fb 键。通道下拉贴着
                  发送键——它改的是「这条从哪出去」，与停止是两回事，故只管自己那一格。 */}
              <div className="flex shrink-0 items-center gap-1 max-lg:ml-auto">
                {/* 停止 = 一枚 ESC 键帽：位置恒在（进出会拉动旁边的发送键），尺寸恒方
                    （`h-6 w-6`、窄屏 `h-8 w-8`，与发送键和换行键同高）；**恒可点**
                    （宿主里 ESC 后面还要接 rewind，这一枚就是那记键），只在点完之后
                    冷却几秒——连发会把刚开的那层菜单也退掉。 */}
                <button
                  type="button"
                  title={t('tasks.stopTooltip')}
                  aria-label={t('tasks.stopTooltip')}
                  disabled={escCooldown > 0}
                  onClick={() => {
                    onInterrupt(sessionId);
                    setEscCooldown(ESC_COOLDOWN_S);
                  }}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-edge/[0.1] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-30 disabled:hover:border-edge/[0.1] disabled:hover:text-neutral-400 max-lg:h-6 max-lg:w-6"
                >
                  <FeedbackIcon
                    state={interruptStateOf(sessionId)}
                    className="h-3 w-3"
                    icon={
                      <span className="text-9 font-medium tracking-tight max-lg:text-10">
                        {escCooldown > 0 ? escCooldown : 'ESC'}
                      </span>
                    }
                  />
                </button>
                {/* 硬中断 = 一枚 Ctrl+C 键帽：与 ESC 同格同冷却口径（连发没有意义）。
                    不落转录标记，「停没停」判不了，只报送出。 */}
                <button
                  type="button"
                  title={t('tasks.ctrlCTooltip')}
                  aria-label={t('tasks.ctrlCTooltip')}
                  disabled={ctrlCCooldown > 0}
                  onClick={() => {
                    void fb.run(
                      `ctrlC:${sessionId}`,
                      async () => {
                        await api.pressSessionCtrlC(sessionId);
                      },
                      { fail: (e) => t('tasks.ctrlCFailed', { error: errorText(e) }) },
                    );
                    setCtrlCCooldown(ESC_COOLDOWN_S);
                  }}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-edge/[0.1] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-30 disabled:hover:border-edge/[0.1] disabled:hover:text-neutral-400 max-lg:h-6 max-lg:w-6"
                >
                  <FeedbackIcon
                    state={fb.stateOf(`ctrlC:${sessionId}`)}
                    className="h-3 w-3"
                    icon={
                      ctrlCCooldown > 0 ? (
                        <span className="text-9 font-medium tracking-tight max-lg:text-10">
                          {ctrlCCooldown}
                        </span>
                      ) : (
                        <Square className="h-2.5 w-2.5 fill-current max-lg:h-3 max-lg:w-3" />
                      )
                    }
                  />
                </button>
                {/* 手动提交 = 一枚 Enter 键帽：提交宿主输入框里现成的内容（层② 自动
                    补打的手动版）。盲打回车提交的是整个输入框——框里若有别的东西会
                    一起出去，tooltip 如实说明。 */}
                <button
                  type="button"
                  title={t('tasks.enterTooltip')}
                  aria-label={t('tasks.enterTooltip')}
                  disabled={!capability.prompt || fb.stateOf(`pressEnter:${sessionId}`) === 'loading'}
                  onClick={() => {
                    void fb.run(
                      `pressEnter:${sessionId}`,
                      async () => {
                        await api.pressSessionEnter(sessionId);
                      },
                      { fail: (e) => t('tasks.enterFailed', { error: errorText(e) }) },
                    );
                  }}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-edge/[0.1] text-neutral-400 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-30 disabled:hover:border-edge/[0.1] disabled:hover:text-neutral-400 max-lg:h-6 max-lg:w-6"
                >
                  <FeedbackIcon
                    state={fb.stateOf(`pressEnter:${sessionId}`)}
                    className="h-3 w-3"
                    icon={<CornerDownLeft className="h-3 w-3" />}
                  />
                </button>
                {/* 发送 = split button：主体发送；桌面端贴一枚下拉箭头展开键序菜单
                    （发送/换行键序切换，全局偏好 localStorage 记住，placeholder 文案
                    跟着走）。移动端只有发送钮本体——换行有专门的键帽，键序无从谈起。 */}
                <div className="flex shrink-0 items-stretch">
                  <button
                    type="button"
                    disabled={
                      !capability.prompt ||
                      (!draft.trim() && staged.length === 0) ||
                      // 附件还在传：此刻发出去等于把它悄悄丢掉
                      staged.some((s) => s.state === 'uploading') ||
                      fb.stateOf(`sendMsg:${sessionId}`) === 'loading'
                    }
                    title={
                      capability.prompt
                        ? undefined
                        : (capability.unsupportedReasons?.prompt ?? t('tasks.msgUnsupported'))
                    }
                    aria-label={t('tasks.messagesSend')}
                    onClick={send}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-l bg-blue-600/80 text-white transition-colors hover:bg-blue-500 disabled:opacity-40 max-lg:h-6 max-lg:w-6 max-lg:rounded-r"
                  >
                    <FeedbackIcon
                      state={fb.stateOf(`sendMsg:${sessionId}`)}
                      className="h-3 w-3"
                      icon={<Send className="h-3 w-3" />}
                    />
                  </button>
                  {isDesktop && (
                    /* flex：这层若是 block，inline-flex 按钮落在文本行盒里，descender
                       会把层撑高 1px——整组随之错位（主钮上浮、与键帽不齐）。 */
                    <div className="relative flex" ref={sendKeyMenuRef}>
                      <button
                        type="button"
                        title={t('tasks.msgSendKeyToggle', { combo: sendCombo, other: newlineCombo })}
                        aria-label={t('tasks.msgSendKeyToggle', { combo: sendCombo, other: newlineCombo })}
                        aria-expanded={sendKeyMenu}
                        onClick={() => setSendKeyMenu((v) => !v)}
                        className="inline-flex h-6 w-4 shrink-0 items-center justify-center rounded-r border-l border-blue-400/40 bg-blue-600/80 text-white transition-colors hover:bg-blue-500"
                      >
                        <ChevronDown className={cn('h-2.5 w-2.5', sendKeyMenu && 'rotate-180')} />
                      </button>
                      {sendKeyMenu && (
                        <div
                          data-send-key-menu
                          className="absolute bottom-full right-0 z-30 mb-1 rounded-lg border border-edge/[0.1] bg-neutral-900 py-1 shadow-mac"
                        >
                          {(['ctrl-enter', 'enter'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => {
                                setSendKey(mode);
                                setSendKeyMenu(false);
                              }}
                              className={cn(
                                'flex w-full items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-left text-11',
                                sendKey === mode ? 'text-neutral-100' : 'text-neutral-400 hover:bg-edge/[0.06]',
                              )}
                            >
                              <Check
                                className={cn('h-3 w-3 shrink-0', sendKey === mode ? 'text-blue-400' : 'invisible')}
                              />
                              {mode === 'ctrl-enter'
                                ? t('tasks.sendKeyCtrlEnter')
                                : t('tasks.sendKeyEnter')}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 状态栏条（输入框下方、贴底边）：只读，配置入口在个性化配置里；
            一块都渲染不出（配置里的块都要宿主 stdin 字段）就不摆（见 StatuslineBar）。 */}
        <StatuslineBar
          projectId={projectId}
          sessionName={sessionRow?.title ?? label}
          model={modelDisplay}
          effort={sessionRow?.effort ?? null}
          contextTokens={sessionRow?.contextTokens ?? null}
          contextPercent={contextPercent}
        />

        {/* 拖角改大小（浮窗限定：嵌入右栏时尺寸归布局；全屏时尺寸归视口。
            触屏同样可用——pointer capture + touch-none，grip 自身不吃滚动） */}
        {!embedded && !fullscreen && (
          <div
            role="separator"
            title={t('app.resizeDialog')}
            aria-label={t('app.resizeDialog')}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none max-lg:h-6 max-lg:w-6"
          >
            <span className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 rounded-br border-b border-r border-edge/20 max-lg:bottom-1.5 max-lg:right-1.5 max-lg:h-3 max-lg:w-3" />
          </div>
        )}

        {/* 弹出菜单：气泡右键一项「多选」／分享图片两项（复制 / 下载）。 */}
        {menu &&
          createPortal(
            <div
              data-conv-menu
              className="fixed z-[60] rounded-lg border border-edge/[0.1] bg-neutral-900 py-1 shadow-mac"
              style={
                menu.kind === 'share'
                  ? { left: menu.left, bottom: menu.bottom }
                  : {
                      left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
                      top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H)),
                    }
              }
              onClick={(e) => e.stopPropagation()}
            >
              {menu.kind === 'bubble' ? (
                <>
                  <button
                    type="button"
                    onClick={() => enterSelect(menu.key)}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <Check className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convSelect')}
                  </button>
                  {/* 汇总的是这一轮（锚所在轮：上一次回复 → 这一次回复）；「全部」在弹窗里切。
                      只对宿主回复的气泡出：我方发送的没有改动可言。 */}
                  {menuEntry?.role === 'assistant' && (
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(null);
                        setEditsRange(editsWindowOf(thread, menu.key));
                        setEditsOpen(true);
                      }}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
                    >
                      <FileDiff className="h-3 w-3 text-neutral-500" />
                      {t('tasks.editsTitle')}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => shareImage('clipboard')}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <Copy className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareCopy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => shareImage('download')}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <Download className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareDownload')}
                  </button>
                  <button
                    type="button"
                    onClick={exportHtml}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <FileCode className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareHtml')}
                  </button>
                  <button
                    type="button"
                    onClick={() => exportMarkdown(pickedEntries())}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <FileText className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareMd')}
                  </button>
                </>
              )}
            </div>,
            document.body,
          )}

        {/* 大图（缩略图点击）：点空白/关钮即收；拖角/菜单同在 z-60 之上，别被压住 */}
        {lightbox &&
          createPortal(
            <div
              className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6"
              onClick={() => setLightbox(null)}
            >
              <button
                type="button"
                title={t('tasks.msgImagePreview')}
                aria-label={t('tasks.msgImagePreview')}
                onClick={() => setLightbox(null)}
                className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge/[0.15] bg-neutral-900 text-neutral-300 hover:text-neutral-100"
              >
                <X className="h-4 w-4" />
              </button>
              <img
                src={`${API_BASE}/images/${lightbox.id}`}
                alt={lightbox.name}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full rounded-lg border border-edge/[0.12] object-contain"
              />
            </div>,
            document.body,
          )}
        {/* 大图也是一层：返回键先收它（z-70 在一切之上，后挂的先退） */}
        <LightboxBackPop open={lightbox != null} onClose={() => setLightbox(null)} />

        {/* 关闭确认（非原生）：挂在面板内——面板自己 stopPropagation，
            点确认框的任何一处都不会被背后的遮罩当成「点外面即关」。 */}
        <ConfirmDialog
          open={confirming}
          title={t('tasks.msgCloseConfirmTitle')}
          message={t('tasks.msgCloseConfirm')}
          confirmLabel={t('tasks.messagesClose')}
          onConfirm={() => onClose?.()}
          onClose={() => setConfirming(false)}
        />

        {/* 切模式确认：同上一份弹窗范式（z-50 同层，后渲染的那扇在上）。 */}
        <ConfirmDialog
          open={confirmMode}
          title={t('tasks.modeConfirmTitle')}
          message={t('tasks.modeConfirm')}
          confirmLabel={t('tasks.modeConfirmAction')}
          onConfirm={cycleMode}
          onClose={() => setConfirmMode(false)}
        />

        {/* 文件引用选择器：选中的表达式由服务端按 harness 文法算好，这里只管贴进输入框；
            带着 `chip` 来的那次是「改这枚胶囊」，落定就地替换 */}
        {picker && (
          <FilePicker
            sessionId={sessionId}
            projectId={projectId}
            rootLabel={projectLabel}
            linesSupported={capability.pathRefLines}
            dirSupported={capability.pathRefKinds.includes('dir')}
            initial={picker.initial}
            onPick={insertRefs}
            onClose={closePicker}
          />
        )}

        {/* 改动汇总：默认这一轮的文件（取数归 harness 能力面，diff 在本页算） */}
        <SessionEditsDialog
          sessionId={sessionId}
          range={editsRange}
          open={editsOpen}
          onClose={() => setEditsOpen(false)}
        />

        {/* 旁路会话（claude = /btw）：问句只有 weave 自己记，回答由采集事件认领回来 */}
        {sideOpen && (
          <SideQuestionDialog
            sessionId={sessionId}
            label={label}
            onClose={() => setSideOpen(false)}
          />
        )}
      </div>
  );

  // 嵌入右栏时 body 本来就在文档流里；全屏要脱离右栏的容器（祖先可能有
  // transform/filter 建了包含块），故那一刻改走 portal。
  if (embedded) return fullscreen ? createPortal(body, document.body) : body;

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 items-center justify-center bg-black/50 p-4',
        minimized ? 'hidden' : 'flex',
      )}
      onClick={onMinimize}
    >
      {body}
    </div>,
    document.body,
  );
}
