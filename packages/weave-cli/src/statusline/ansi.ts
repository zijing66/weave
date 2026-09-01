/**
 * ANSI SGR span parser for the statusline preview.
 *
 * The generated statusline script colours its output with a small, closed set
 * of SGR codes (see generator.ts: `paint()` and `dim()`). This module parses
 * that output back into spans so the Ink preview can re-render the exact same
 * line with native <Text color backgroundColor bold> props — the preview is
 * the real script output, not a re-implementation.
 */

/** Ink colour names, matching the script's StatuslineColor palette. */
export type PreviewColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

/** One run of text sharing a single SGR styling. */
export interface AnsiSpan {
  text: string;
  color?: PreviewColor;
  backgroundColor?: PreviewColor;
  bold?: boolean;
  dim?: boolean;
}

/** SGR foreground codes → Ink colour names. */
const FG_CODES: Record<string, PreviewColor> = {
  '31': 'red',
  '32': 'green',
  '33': 'yellow',
  '34': 'blue',
  '35': 'magenta',
  '36': 'cyan',
  '90': 'gray',
};

/** SGR background codes → Ink colour names. */
const BG_CODES: Record<string, PreviewColor> = {
  '41': 'red',
  '42': 'green',
  '43': 'yellow',
  '44': 'blue',
  '45': 'magenta',
  '46': 'cyan',
  '100': 'gray',
};

/**
 * Split a line containing SGR sequences into styled spans. Unknown codes are
 * ignored (treated as transparent styling); the reset code (0) clears the
 * current style. Plain input without any escape yields a single unstyled span.
 */
export function parseAnsiSpans(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let current: AnsiSpan | undefined;
  let plain = '';

  const pushCurrent = () => {
    if (current && current.text) spans.push(current);
    current = undefined;
  };
  const pushPlain = () => {
    if (plain) {
      spans.push({ text: plain });
      plain = '';
    }
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
    if (!codes.length) continue;
    if (codes.includes('0')) {
      // Reset: flush the styled span and fall back to plain text.
      pushCurrent();
      continue;
    }
    pushPlain();
    if (!current) current = { text: '' };
    for (const code of codes) {
      const fg = FG_CODES[code];
      const bg = BG_CODES[code];
      if (fg) current.color = fg;
      else if (bg) current.backgroundColor = bg;
      else if (code === '1') current.bold = true;
      else if (code === '2') current.dim = true;
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
