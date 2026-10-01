/**
 * ANSI SGR span parser for the statusline preview.
 *
 * The generated statusline script colours its output with a closed set of SGR
 * codes (see generator.ts: `paint()` and `dim()`). This module parses that
 * output back into spans so the Ink preview can re-render the exact same line
 * with native <Text color backgroundColor bold> props — the preview is the
 * real script output, not a re-implementation.
 *
 * Colours come back as the same strings the config stores (a named ANSI
 * colour, `ansi256:N`, or `#rrggbb`) so spans round-trip through the editor
 * without a lossy mapping; `toInkColor` converts one for Ink's `color` prop.
 */

/**
 * A parsed colour: a named ANSI colour, `ansi256:N`, or `#rrggbb`.
 * Deliberately the config's `StatuslineColor` vocabulary, not Ink's.
 */
export type PreviewColor = string;

/** One run of text sharing a single SGR styling. */
export interface AnsiSpan {
  text: string;
  color?: PreviewColor;
  backgroundColor?: PreviewColor;
  bold?: boolean;
  dim?: boolean;
}

/** SGR foreground codes → colour names. */
const FG_CODES: Record<string, string> = {
  '31': 'red',
  '32': 'green',
  '33': 'yellow',
  '34': 'blue',
  '35': 'magenta',
  '36': 'cyan',
  '90': 'gray',
};

/** SGR background codes → colour names. */
const BG_CODES: Record<string, string> = {
  '41': 'red',
  '42': 'green',
  '43': 'yellow',
  '44': 'blue',
  '45': 'magenta',
  '46': 'cyan',
  '100': 'gray',
};

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Translate a parsed colour into the string Ink's `<Text color>` expects.
 * Ink delegates to chalk, which spells indexed colours `ansi256(N)` — not the
 * `ansi256:N` the config uses — and passes `#rrggbb` through unchanged.
 */
export function toInkColor(color: string): string {
  const prefix = 'ansi256:';
  return color.startsWith(prefix) ? `ansi256(${color.slice(prefix.length)})` : color;
}

/**
 * Read an extended colour starting at `codes[i]` — `38` (foreground) or `48`
 * (background). These consume either three slots (`38;5;N`) or five
 * (`38;2;R;G;B`), which is why the caller tracks an index rather than
 * iterating code-by-code. Returns null when the sequence is malformed.
 */
function readExtended(codes: string[], i: number, lead: string): { value: string; next: number } | null {
  if (codes[i] !== lead) return null;

  if (codes[i + 1] === '5' && codes[i + 2] !== undefined) {
    const n = Number(codes[i + 2]);
    if (Number.isInteger(n) && n >= 0 && n <= 255) {
      return { value: `ansi256:${n}`, next: i + 3 };
    }
    return null;
  }

  if (codes[i + 1] === '2' && codes[i + 4] !== undefined) {
    const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]].map(Number);
    if ([r, g, b].every((v) => Number.isFinite(v))) {
      return { value: rgbToHex(r!, g!, b!), next: i + 5 };
    }
    return null;
  }

  return null;
}

/**
 * Split a line containing SGR sequences into styled spans. Unknown codes are
 * ignored (treated as transparent styling); a reset (0) flushes the current
 * span. Plain input without any escape yields a single unstyled span.
 *
 * Note `0` is only a reset when it stands alone: inside `38;5;0` it is the
 * palette index for black, and treating it as a reset would drop the style.
 */
export function parseAnsiSpans(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let current: AnsiSpan | undefined;
  let plain = '';

  const pushCurrent = (): void => {
    if (current && current.text) spans.push(current);
    current = undefined;
  };
  const pushPlain = (): void => {
    if (plain) {
      spans.push({ text: plain });
      plain = '';
    }
  };
  const ensureCurrent = (): AnsiSpan => {
    if (!current) {
      pushPlain();
      current = { text: '' };
    }
    return current;
  };

  // Split on SGR sequences: \x1b[<params>m — everything else is literal text.
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    const match = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!match) {
      if (part) {
        if (current) current.text += part;
        else plain += part;
      }
      continue;
    }

    const codes = match[1].split(';').filter((c) => c !== '');
    for (let i = 0; i < codes.length; ) {
      const fg = readExtended(codes, i, '38');
      if (fg) {
        ensureCurrent().color = fg.value;
        i = fg.next;
        continue;
      }
      const bg = readExtended(codes, i, '48');
      if (bg) {
        ensureCurrent().backgroundColor = bg.value;
        i = bg.next;
        continue;
      }

      const code = codes[i]!;
      if (code === '0') {
        pushCurrent();
      } else if (code === '1') {
        ensureCurrent().bold = true;
      } else if (code === '2') {
        ensureCurrent().dim = true;
      } else if (FG_CODES[code]) {
        ensureCurrent().color = FG_CODES[code];
      } else if (BG_CODES[code]) {
        ensureCurrent().backgroundColor = BG_CODES[code];
      }
      i++;
    }
  }
  pushCurrent();
  pushPlain();
  return spans;
}

/** Strip every SGR sequence — used for width measurement and tests. */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}
