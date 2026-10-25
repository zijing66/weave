/** 行级 diff 的一行：`same` 未变、`add` 只在新文本、`del` 只在旧文本。 */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const MAX_LINES = 4000;

/**
 * LCS 行级 diff（配置快照对活文件，量级几百行，`O(n*m)` 足够）。
 * 超过 `MAX_LINES` 时不做对齐、整段当地删增——diff 只是确认弹窗的辅助，不值当为超大文件卡住页面。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  // 末尾换行产生的空行不参与比对
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** 变更行数（只数增删，给弹窗标题用）。 */
export function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'del') removed++;
  }
  return { added, removed };
}

/**
 * 折叠未变区：保留变更行前后各 `context` 行，中间的空档压成一段 `skip`，
 * 免得把整份文件铺在弹窗里。
 */
export type DiffRow = DiffLine | { kind: 'skip'; count: number };

export function collapseDiff(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });

  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ kind: 'skip', count: skipped });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: 'skip', count: skipped });
  return out;
}

/** 左右分栏的一行：`mod` = 配上对的删+增（左旧右新），孤侧补空行占位。 */
export interface SplitDiffRow {
  kind: 'same' | 'mod' | 'add' | 'del' | 'skip';
  left: string | null;
  right: string | null;
  count?: number;
}

/**
 * 把行级 diff 配对成左右两栏（Beyond Compare 式）：`same` 两侧同行；
 * 连续 `del` 与连续 `add` 按序配对成 `mod`、多出的一侧补空行；`skip` 整行横跨两栏。
 */
export function pairSplitRows(rows: readonly DiffRow[]): SplitDiffRow[] {
  const out: SplitDiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind === 'skip') {
      out.push({ kind: 'skip', left: null, right: null, count: row.count });
      i++;
      continue;
    }
    if (row.kind !== 'del') {
      out.push(row.kind === 'add'
        ? { kind: 'add', left: null, right: row.text }
        : { kind: 'same', left: row.text, right: row.text });
      i++;
      continue;
    }
    // 连续 del 段与紧随的连续 add 段按序配对
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'del') j++;
    let k = j;
    while (k < rows.length && rows[k]!.kind === 'add') k++;
    const dels = rows.slice(i, j) as Extract<DiffRow, DiffLine>[];
    const adds = rows.slice(j, k) as Extract<DiffRow, DiffLine>[];
    const len = Math.max(dels.length, adds.length);
    for (let n = 0; n < len; n++) {
      const left = dels[n]?.text ?? null;
      const right = adds[n]?.text ?? null;
      out.push({
        kind: left !== null && right !== null ? 'mod' : left !== null ? 'del' : 'add',
        left,
        right,
      });
    }
    i = k;
  }
  return out;
}
