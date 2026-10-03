import type { StatuslineColor, StatuslineNamedColor } from '@/lib/api';

/**
 * Colour resolution for the statusline panel.
 *
 * The panel used to render colours as Tailwind classes, which only works for a
 * fixed palette. Configs now accept 256-colour indices and arbitrary hex, so
 * colours are resolved to concrete CSS values and applied via inline styles.
 *
 * Named colours map to two palettes: a saturated one for swatches and
 * background blocks, and a lighter one for foreground text — mirroring how a
 * terminal's bright variants read against a dark background, which is what the
 * class-based version approximated.
 */

/** The seven classic names → saturated swatch/background colours. */
const NAMED_SOLID: Record<StatuslineNamedColor, string> = {
  gray: '#6b7280',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#d946ef',
  cyan: '#06b6d4',
};

/** The seven classic names → lighter foreground colours. */
const NAMED_FG: Record<StatuslineNamedColor, string> = {
  gray: '#d1d5db',
  red: '#fca5a5',
  green: '#86efac',
  yellow: '#fde68a',
  blue: '#bfdbfe',
  magenta: '#f5d0fe',
  cyan: '#a5f3fc',
};

/** The 16 system colours, as xterm defines them. */
const SYSTEM_16 = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
] as const;

/** xterm 256-colour index → `#rrggbb`, per the standard cube + greyscale ramp. */
export function ansi256ToHex(index: number): string {
  const n = Math.max(0, Math.min(255, Math.round(index)));
  if (n < 16) return SYSTEM_16[n]!;

  const hex = (v: number): string => v.toString(16).padStart(2, '0');

  if (n < 232) {
    const cube = n - 16;
    // each axis steps 0, 95, 135, 175, 215, 255
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor((cube % 36) / 6)))}${hex(level(cube % 6))}`;
  }
  const grey = 8 + (n - 232) * 10;
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}

const isNamed = (color: string): color is StatuslineNamedColor => color in NAMED_SOLID;

/** Resolve a config colour to a CSS colour for text/strokes. */
export function cssFg(color: StatuslineColor): string {
  if (isNamed(color)) return NAMED_FG[color];
  if (color.startsWith('ansi256:')) return ansi256ToHex(Number(color.slice('ansi256:'.length)));
  return color;
}

/** Resolve a config colour to a CSS colour for swatches and background blocks. */
export function cssSolid(color: StatuslineColor): string {
  if (isNamed(color)) return NAMED_SOLID[color];
  if (color.startsWith('ansi256:')) return ansi256ToHex(Number(color.slice('ansi256:'.length)));
  return color;
}

/** A short human label for a colour, used in tooltips. */
export function colorLabel(color: StatuslineColor): string {
  if (isNamed(color)) return color;
  if (color.startsWith('ansi256:')) return `ansi256 ${color.slice('ansi256:'.length)}`;
  return color;
}

/**
 * Validate a free-text colour entry from the editor. Returns the normalised
 * value, or null when it is not a colour the config understands.
 *
 * Mirrors `normalizeColor` in packages/weave-server — the server stays the
 * authority; this only gives the editor immediate feedback.
 */
export function parseColorInput(value: string): StatuslineColor | null {
  const v = value.trim();
  if (isNamed(v)) return v;

  const indexed = /^ansi256:(\d{1,3})$/.exec(v);
  if (indexed) {
    const n = Number(indexed[1]);
    return n >= 0 && n <= 255 ? (`ansi256:${n}` as StatuslineColor) : null;
  }

  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase() as StatuslineColor;

  const short = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (short) {
    const h = short[1]!;
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase() as StatuslineColor;
  }
  return null;
}

/** The 256-colour grid for the picker popover, as `#rrggbb` values. */
export const ANSI256_GRID: string[] = Array.from({ length: 256 }, (_, i) => ansi256ToHex(i));
