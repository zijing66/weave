import path from 'node:path';

/** 注入指令的防递归标记：inject/manual 渲染的指令携带它，采集侧据此跳过自动规则。 */
export const DISPATCH_MARKER = '<!--weave-dispatch-->';

const foldCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** 反斜杠归一为 posix（Windows 的 file_path 是原生分隔符）。 */
export function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function escapeRegex(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

const globCache = new Map<string, RegExp>();

/**
 * glob 编译为 RegExp：双星号+分隔符匹配任意层前缀、双星号匹配任意段、
 * 星号匹配单段内、问号匹配单字符。大小写不敏感（Windows 路径）。
 */
export function globToRegex(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += escapeRegex(c);
    }
  }
  const compiled = new RegExp(`^${re}$`, 'i');
  globCache.set(glob, compiled);
  return compiled;
}

/** file_path 与 glob 匹配（两侧都归一为 posix）。 */
export function matchGlob(filePath: string, glob: string): boolean {
  return globToRegex(glob).test(normalizePosix(filePath));
}

/** 从 toolInput 提取文件路径（Write/Edit 的 file_path、NotebookEdit 的 notebook_path）。 */
export function extractFilePath(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const obj = toolInput as Record<string, unknown>;
  for (const key of ['file_path', 'notebook_path', 'filePath']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function isWithin(target: string, base: string): boolean {
  const t = foldCase(normalizePosix(target));
  const b = foldCase(normalizePosix(base).replace(/\/+$/, ''));
  return t === b || t.startsWith(`${b}/`);
}

/**
 * 多项目交互判定：target 落在**其他**已注册项目根下（而非当前项目自身）。
 * currentPath 排除自身；无命中返回 false。
 */
export function isCrossProjectPath(
  target: string,
  currentPath: string,
  otherProjectPaths: string[],
): boolean {
  const current = foldCase(normalizePosix(currentPath));
  if (isWithin(target, currentPath)) return false;
  return otherProjectPaths.some((p) => foldCase(normalizePosix(p)) !== current && isWithin(target, p));
}

/**
 * 渲染指令模板：`{event}` `{tool}` `{file}` `{cwd}` `{session}` `{project}` `{rule}`
 * 未知占位原样保留（缺参可见，不渲染 undefined）。
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

/** 事件 → 模板变量。 */
export function templateVars(input: {
  event: string;
  tool: string | null;
  filePath: string | null;
  cwd: string | null;
  session: string | null;
  project: string;
  rule: string;
}): Record<string, string | null> {
  return {
    event: input.event,
    tool: input.tool,
    file: input.filePath ? normalizePosix(input.filePath) : null,
    cwd: input.cwd ? normalizePosix(input.cwd) : null,
    session: input.session,
    project: input.project,
    rule: input.rule,
  };
}

/** toolInput.file_path 是否落在任一 glob（posix 归一后比较）。 */
export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(filePath, g));
}

/** 项目根 basename（会话/指令里展示用）。 */
export function projectLabel(projectPath: string): string {
  return path.basename(normalizePosix(projectPath).replace(/\/+$/, '')) || projectPath;
}
