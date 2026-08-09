const colors: Record<string, string> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function colorize(msg: string, code: keyof typeof colors): string {
  if (process.env.NO_COLOR) return msg;
  return `${colors[code]}${msg}${colors.reset}`;
}

export const logger = {
  info(msg: string): void {
    console.log(colorize(msg, 'cyan'));
  },
  success(msg: string): void {
    console.log(colorize(msg, 'green'));
  },
  warn(msg: string): void {
    console.log(colorize(msg, 'yellow'));
  },
  error(msg: string): void {
    console.error(colorize(msg, 'red'));
  },
  dim(msg: string): void {
    console.log(colorize(msg, 'dim'));
  },
};

export function formatTable(rows: [string, string][]): string {
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  return rows.map(([label, value]) => `  ${label.padEnd(labelWidth + 2)}${value}`).join('\n');
}
