/**
 * node-pty 薄封装：动态 import——原生模块只在 Runtime Host 子进程里加载，
 * daemon 进程零接触（装了 node-pty 的机器上 daemon 不引它也能跑）。
 */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

type NodePty = typeof import('node-pty');

let ptyMod: NodePty | null = null;

async function nodePty(): Promise<NodePty> {
  if (!ptyMod) ptyMod = (await import('node-pty')) as NodePty;
  return ptyMod;
}

export async function spawnPty(file: string, args: string[], opts: PtySpawnOptions): Promise<PtyProcess> {
  const pty = await nodePty();
  return pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  }) as unknown as PtyProcess;
}
