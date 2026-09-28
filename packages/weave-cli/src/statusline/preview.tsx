import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import {
  applyStatuslineConfig,
  generateStatuslineScript,
  readStatuslineConfig,
  writeGlobalStatuslineConfig,
  type SegmentKey,
  type StatuslineColor,
  type StatuslineConfig,
} from '@weave/server';
import { parseAnsiSpans } from './ansi.js';
import { buildMockInput } from './mock-input.js';

/**
 * Interactive statusline preview TUI (Ink).
 *
 * Renders the REAL generated script's output — on every config edit the script
 * is regenerated, run against a sample Claude Code stdin payload, and its ANSI
 * output parsed back into styled spans (`ansi.ts`). The editing surface is
 * keyboard-driven; `w` persists the working config back to wherever it came
 * from (the project's `.weave/statusline.json` or the global template).
 *
 * The pure config-editing helpers at the bottom are unit-tested; the Ink
 * component is a thin shell over them.
 */

/** Cursor position in the `lines` grid (row = line index, col = segment index). */
export interface Cursor {
  row: number;
  col: number;
}

/** Cycle lists for the single-key toggles. */
const COLORS: StatuslineColor[] = ['gray', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
const SEPARATORS = [' │ ', ' · ', ' — ', '  ', ''];
const ALIGNS: StatuslineConfig['align'][] = ['left', 'center', 'right'];
const CONTEXT_STYLES: NonNullable<
  StatuslineConfig['segments'][SegmentKey]['style']
>[] = ['percent', 'bar', 'both'];

/** Segment key → icon candidates (cycled with `i`). */
const ICONS: Partial<Record<SegmentKey, string[]>> = {
  project: ['', '📁'],
  git: ['', '🌿'],
  changes: ['', '✏️'],
  model: ['', '🤖'],
  thinking: ['', '🧠'],
  context: ['', '📊'],
  tokens: ['', '🔢'],
  cost: ['', '💰'],
  rate: ['', '⚡'],
  time: ['', '🕒'],
};

/** Run the generated script against the mock payload and capture its output. */
export function runPreviewLines(
  config: StatuslineConfig,
  projectPath: string,
  columns: number,
): { lines: string[]; error?: string } {
  const script = generateStatuslineScript(config);
  // `node -e` cannot start with a shebang — strip the first line.
  const source = script.replace(/^#!.*\n/, '');
  const input = JSON.stringify(buildMockInput(projectPath, columns));
  try {
    const res = spawnSync(process.execPath, ['-e', source], {
      input,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    if (res.status !== 0) {
      return { lines: [], error: (res.stderr || `exit ${res.status}`).trim() };
    }
    const out = (res.stdout ?? '').replace(/\r\n/g, '\n');
    return { lines: out.split('\n').filter((l) => l !== '') };
  } catch (e) {
    return { lines: [], error: String(e) };
  }
}

// --- pure config editors (unit-tested) ---

function patchSegment(
  config: StatuslineConfig,
  key: SegmentKey,
  patch: Partial<StatuslineConfig['segments'][SegmentKey]>,
): StatuslineConfig {
  return {
    ...config,
    segments: { ...config.segments, [key]: { ...config.segments[key], ...patch } },
  };
}

export function toggleSegment(config: StatuslineConfig, key: SegmentKey): StatuslineConfig {
  return patchSegment(config, key, { enabled: !config.segments[key].enabled });
}

export function cycleSegmentColor(config: StatuslineConfig, key: SegmentKey): StatuslineConfig {
  const i = COLORS.indexOf(config.segments[key].color);
  return patchSegment(config, key, { color: COLORS[(i + 1) % COLORS.length] });
}

export function toggleSegmentBold(config: StatuslineConfig, key: SegmentKey): StatuslineConfig {
  return patchSegment(config, key, { bold: !config.segments[key].bold });
}

export function toggleSegmentMerge(config: StatuslineConfig, key: SegmentKey): StatuslineConfig {
  return patchSegment(config, key, { merge: !config.segments[key].merge });
}

export function cycleSegmentIcon(config: StatuslineConfig, key: SegmentKey): StatuslineConfig {
  const list = ICONS[key] ?? [''];
  const i = list.indexOf(config.segments[key].icon);
  return patchSegment(config, key, { icon: list[(i + 1) % list.length] });
}

export function cycleContextStyle(config: StatuslineConfig, key: SegmentKey): StatuslineConfig {
  if (key !== 'context') return config;
  const list = CONTEXT_STYLES;
  const i = list.indexOf(config.segments[key].style ?? 'both');
  return patchSegment(config, key, { style: list[(i + 1) % list.length] });
}

export function cycleAlign(config: StatuslineConfig): StatuslineConfig {
  const i = ALIGNS.indexOf(config.align);
  return { ...config, align: ALIGNS[(i + 1) % ALIGNS.length] };
}

export function togglePowerline(config: StatuslineConfig): StatuslineConfig {
  return { ...config, powerline: { ...config.powerline, enabled: !config.powerline.enabled } };
}

/** Nerd-Font join-separator presets cycled with `g` (classic triangles first). */
const PL_JOINS = ['', '', '', ''];

export function cyclePowerlineGlyph(config: StatuslineConfig): StatuslineConfig {
  const cur = config.powerline.separator ?? PL_JOINS[0]!;
  const i = PL_JOINS.indexOf(cur);
  const next = PL_JOINS[(i + 1) % PL_JOINS.length]!;
  return { ...config, powerline: { ...config.powerline, separator: next } };
}

export function toggleLogo(config: StatuslineConfig): StatuslineConfig {
  return { ...config, showLogo: !config.showLogo };
}

export function cycleSeparator(config: StatuslineConfig): StatuslineConfig {
  const i = SEPARATORS.indexOf(config.separator);
  return { ...config, separator: SEPARATORS[(i + 1) % SEPARATORS.length] };
}

export function bumpRefreshInterval(config: StatuslineConfig, delta: number): StatuslineConfig {
  return {
    ...config,
    refreshInterval: Math.max(1, config.refreshInterval + delta),
  };
}

/** Clamp a cursor to the config's grid, skipping over empty rows. */
export function clampCursor(config: StatuslineConfig, cursor: Cursor): Cursor {
  const rows = config.lines.length;
  const row = Math.min(Math.max(cursor.row, 0), rows - 1);
  const len = config.lines[row]?.length ?? 0;
  const col = Math.min(Math.max(cursor.col, 0), Math.max(0, len - 1));
  return { row, col };
}

/** One key left/right/up/down: clamps rows, skips empty rows on the way back,
 * and clamps the column within the destination row. */
export function moveCursor(config: StatuslineConfig, cursor: Cursor, dr: number, dc: number): Cursor {
  const rows = config.lines.length;
  const target = Math.min(Math.max(cursor.row + dr, 0), rows - 1);
  // Walk back toward the origin row when the target row has no segments.
  let row = target;
  while (row !== cursor.row && (config.lines[row]?.length ?? 0) === 0) {
    row -= Math.sign(row - cursor.row) || 1;
  }
  if ((config.lines[row]?.length ?? 0) === 0) {
    // The origin row is empty too — stay put.
    return cursor;
  }
  const len = config.lines[row].length;
  let col = cursor.col + dc;
  if (col >= len) col = len - 1;
  if (col < 0) col = 0;
  return { row, col };
}

// --- Ink app ---

function SpanLine({ line }: { line: string }) {
  const spans = parseAnsiSpans(line);
  return (
    <Text>
      {spans.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          backgroundColor={s.backgroundColor}
          bold={s.bold}
          dimColor={s.dim}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function SegmentChip({
  segmentKey,
  seg,
  focused,
}: {
  segmentKey: SegmentKey;
  seg: StatuslineConfig['segments'][SegmentKey];
  focused: boolean;
}) {
  const label = `${seg.enabled ? '●' : '○'}${seg.icon ? seg.icon : ''}${segmentKey}`;
  return (
    <Text
      color={seg.enabled ? seg.color : 'gray'}
      bold={focused}
      inverse={focused}
      dimColor={!seg.enabled}
    >
      {label}
    </Text>
  );
}

function PreviewApp({
  initialConfig,
  projectPath,
  initialCursor,
}: {
  initialConfig: StatuslineConfig;
  projectPath: string;
  initialCursor: Cursor;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [config, setConfig] = useState<StatuslineConfig>(initialConfig);
  const [cursor, setCursor] = useState<Cursor>(initialCursor);
  const [output, setOutput] = useState<{ lines: string[]; error?: string }>({ lines: [] });
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  const columns = Math.max(60, stdout?.columns ?? 100);
  const focusKey = config.lines[cursor.row]?.[cursor.col];

  const edit = (fn: (c: StatuslineConfig) => StatuslineConfig): void => {
    setConfig(fn);
    setDirty(true);
    setStatus(null);
  };

  // Re-run the real script whenever the config changes (debounced so a burst of
  // keystrokes triggers one spawn).
  useEffect(() => {
    const t = setTimeout(() => {
      setOutput(runPreviewLines(config, projectPath, columns));
    }, 60);
    return () => clearTimeout(t);
  }, [config, columns, projectPath]);

  useInput((input, key) => {
    if (writing) return;
    if (input === 'q') {
      void exit();
      return;
    }
    if (key.escape) {
      void exit();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => moveCursor(config, c, -1, 0));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => moveCursor(config, c, 1, 0));
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => moveCursor(config, c, 0, -1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => moveCursor(config, c, 0, 1));
      return;
    }
    if (key.return) {
      // Enter on a line row: no-op (segments move via the dashboard); keep the
      // key reserved so `w` stays the only destructive action.
      return;
    }
    if (!focusKey) return;
    switch (input.toLowerCase()) {
      case ' ':
        edit((c) => toggleSegment(c, focusKey));
        return;
      case 'c':
        edit((c) => cycleSegmentColor(c, focusKey));
        return;
      case 'b':
        edit((c) => toggleSegmentBold(c, focusKey));
        return;
      case 'm':
        edit((c) => toggleSegmentMerge(c, focusKey));
        return;
      case 'i':
        edit((c) => cycleSegmentIcon(c, focusKey));
        return;
      case 'v':
        edit((c) => cycleContextStyle(c, focusKey));
        return;
      case 'a':
        edit((c) => cycleAlign(c));
        return;
      case 'p':
        edit((c) => togglePowerline(c));
        return;
      case 'g':
        edit((c) => cyclePowerlineGlyph(c));
        return;
      case 'l':
        edit((c) => toggleLogo(c));
        return;
      case 's':
        edit((c) => cycleSeparator(c));
        return;
      case 'r':
        setOutput(runPreviewLines(config, projectPath, columns));
        setStatus('re-rendered');
        return;
      case 'w':
        void (async () => {
          setWriting(true);
          try {
            // A `global`-source project edits the global template; a `custom`
            // project writes its local config. Both regenerate the script.
            if ((config.source ?? 'global') === 'global') {
              await writeGlobalStatuslineConfig(config);
            }
            await applyStatuslineConfig(projectPath, config);
            setDirty(false);
            setStatus('已写入并重新生成 statusline 脚本');
          } catch (e) {
            setStatus(`写入失败: ${String(e)}`);
          } finally {
            setWriting(false);
          }
        })();
        return;
      default:
        break;
    }
  });

  const seg = focusKey ? config.segments[focusKey] : undefined;

  return (
    <Box flexDirection="column" gap={0}>
      <Box>
        <Text bold color="cyan">
          weave statusline preview
        </Text>
        <Text dimColor> — {path.basename(projectPath)} </Text>
        <Text dimColor>
          source: {config.source ?? 'global'} · refresh: {config.refreshInterval}s · align:{' '}
          {config.align} · powerline: {config.powerline.enabled ? 'on' : 'off'}
        </Text>
        {dirty && (
          <Text color="yellow"> ●未保存</Text>
        )}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        marginY={0}
      >
        {output.error ? (
          <Text color="red">script error: {output.error}</Text>
        ) : output.lines.length ? (
          output.lines.map((l, i) => <SpanLine key={i} line={l} />)
        ) : (
          <Text dimColor>rendering…</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text dimColor>layout — ↑↓←→ 移动 · space 开关</Text>
        {config.lines.map((line, row) => (
          <Box key={row} gap={1}>
            <Text dimColor>{`row ${row + 1}  `}</Text>
            {line.map((k, col) => (
              <SegmentChip
                key={k}
                segmentKey={k}
                seg={config.segments[k]}
                focused={cursor.row === row && cursor.col === col}
              />
            ))}
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" gap={0} marginTop={1}>
        {seg && focusKey ? (
          <Text>
            <Text bold inverse>
              {` ${focusKey} `}
            </Text>{' '}
            <Text dimColor>
              color {seg.color} · bold {seg.bold ? 'on' : 'off'} · merge{' '}
              {seg.merge ? 'on' : 'off'} · icon {seg.icon || '—'}
              {focusKey === 'context' ? ` · style ${seg.style ?? 'both'}` : ''}
            </Text>
          </Text>
        ) : null}
        <Text dimColor>
          keys: c 颜色 · b 粗体 · m 合并 · i 图标 · v 上下文样式 · a 对齐 · p powerline · g
          powerline 分隔符 · l logo · s 分隔符 · r 重渲染 · w 写入 · q 退出
        </Text>
        {status && (
          <Text color="green">{status}</Text>
        )}
        {writing && <Text color="yellow">writing…</Text>}
      </Box>
    </Box>
  );
}

/** Entry point — loads the effective config and mounts the Ink app. */
export async function runStatuslinePreview(projectPath: string): Promise<void> {
  const config = await readStatuslineConfig(projectPath);
  const cursor = clampCursor(config, { row: 0, col: 0 });
  const instance = render(
    <PreviewApp initialConfig={config} projectPath={projectPath} initialCursor={cursor} />,
    { exitOnCtrlC: true },
  );
  // Unmount cleanly when the process exits (q / ctrl-c).
  await instance.waitUntilExit?.();
}
