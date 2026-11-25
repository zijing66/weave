/**
 * 全局搜索的查询语法解析（GitHub Search Syntax 风格，纯函数零 IO）：
 * 裸词（AND 隐含）、`"引号短语"`、`-排除`、`:chat` 分类限定、
 * `project:<名或id>`、`session:<id或标题>`。分类限定符用「冒号起头 /
 * 空格后冒号」——`in` 这类普通词不会误触发。
 * 解析只此一处——`/search` 与联邦 call `search` 共用；无语法 token 的纯文本
 * 解析后 terms=[q]、scopes 全 true（联邦兼容基线）。未知 key/value 按
 * 普通词落 terms（容错：打错字仍能搜，只是不命中限定）。
 */

export interface SearchScopes {
  sessions: boolean;
  messages: boolean;
  files: boolean;
  content: boolean;
}

export interface ParsedQuery {
  terms: string[];
  excludes: string[];
  scopes: SearchScopes;
  projectId: number | null;
  projectName: string | null;
  /** session: 的 uuid/hex 形（服务端精确匹配）。 */
  sessionId: string | null;
  /** session: 的标题子串形（服务端 searchByTitle 找候选）。 */
  sessionTitle: string | null;
  /** 主体检索串（terms join 空格）；空 = 只有过滤词（globalSearch 回空响应）。 */
  text: string;
}

/** 分类限定值别名 → scope 键（`:chat` 主形）。 */
const SCOPE_ALIASES: Record<string, keyof SearchScopes> = {
  chat: 'messages',
  messages: 'messages',
  file: 'files',
  files: 'files',
  content: 'content',
  code: 'content',
  session: 'sessions',
  sessions: 'sessions',
};

/** uuid / 长 hex 形（session: 值判精确 id 还是标题子串；uuid 含连字符）。 */
const ID_LIKE = /^[0-9a-f][0-9a-f-]{15,}$/i;

export function parseSearchQuery(q: string): ParsedQuery {
  const terms: string[] = [];
  const excludes: string[] = [];
  const scopes: SearchScopes = { sessions: false, messages: false, files: false, content: false };
  let anyScope = false;
  const excludedScopes = new Set<keyof SearchScopes>();
  let projectId: number | null = null;
  let projectName: string | null = null;
  let sessionId: string | null = null;
  let sessionTitle: string | null = null;

  // 逐 token 扫描：引号段直接吞到闭引号（含空格算一个 term），其余按空格切。
  const tokens: string[] = [];
  let buf = '';
  let quoted: string | null = null;
  for (const ch of q) {
    if (quoted !== null) {
      if (ch === '"') {
        tokens.push(`"${quoted}"`);
        quoted = null;
        buf = '';
      } else {
        quoted += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (buf.trim()) tokens.push(buf.trim());
      buf = '';
      quoted = '';
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (buf.trim()) tokens.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (quoted !== null) tokens.push(`"${quoted}"`);
  else if (buf.trim()) tokens.push(buf.trim());

  /** 分类限定 token（:chat / in:chat / -in:chat）→ scope 键；不命中返回 null。 */
  const scopeOf = (value: string): keyof SearchScopes | null =>
    SCOPE_ALIASES[value.toLowerCase()] ?? null;

  for (const token of tokens) {
    if (token.startsWith('"')) {
      const inner = token.slice(1, -1).trim();
      if (inner) terms.push(inner);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const rest = token.slice(1);
      // -:chat = 排除分类（只关掉该路，其余 scope 不动）
      const negScope = rest.startsWith(':') ? scopeOf(rest.slice(1)) : null;
      if (negScope) {
        scopes[negScope] = false;
        excludedScopes.add(negScope);
        continue;
      }
      excludes.push(rest);
      continue;
    }
    const lower = token.toLowerCase();
    // 分类限定 = 冒号起头（:chat / :file / :content / :session）
    if (lower.startsWith(':')) {
      const value = lower.slice(1);
      const scope = value ? scopeOf(value) : null;
      if (scope) {
        scopes[scope] = true;
        anyScope = true;
        continue;
      }
      if (!value) continue; // 空值（光标停在冒号上）：忽略，不当搜索词
      terms.push(token);
      continue;
    }
    if (lower.startsWith('project:')) {
      const value = token.slice(8);
      if (value) {
        if (/^\d+$/.test(value)) projectId = Number(value);
        else projectName = value;
        continue;
      }
      terms.push(token);
      continue;
    }
    if (lower.startsWith('session:')) {
      const value = token.slice(8);
      if (value) {
        if (ID_LIKE.test(value)) sessionId = value;
        else sessionTitle = value;
        continue;
      }
      terms.push(token);
      continue;
    }
    terms.push(token);
  }

  if (!anyScope) {
    // 无分类限定显式圈范围 = 四路全搜；但 -: 排除过的路保持 false。
    for (const key of Object.keys(scopes) as (keyof SearchScopes)[]) {
      if (!excludedScopes.has(key)) scopes[key] = true;
    }
  }

  return {
    terms,
    excludes,
    scopes,
    projectId,
    projectName,
    sessionId,
    sessionTitle,
    text: terms.join(' '),
  };
}
