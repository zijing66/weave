import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { listDirOf, matchPaths, projectFileIndex } from '../project-files.js';
import { resolveWithinProject } from '../../install/reader.js';

/**
 * 项目文件数据面路由（project 维度）：文件索引（浏览/搜索）与项目根内只读预览。
 * 数据本质是项目的——session 维度的只剩「引用表达式」两扇（`/sessions/:id/ref`、
 * `/sessions/:id/refs/recognize`，文法按会话的 harness 取），仍在 path-refs.ts。
 */

/** 预览栏的字节上限（比资产读取小：预览只要头几十行，不需要整份大文件）。 */
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/** 文本预览上限：编辑器扛得动更大的，但一次预览不需要整份大文件。 */
const PREVIEW_MAX_TEXT_BYTES = 1024 * 1024;

/** 二进制嗅探窗：前这么多字节里出现 NUL 就当二进制（编辑器渲不出它，别塞乱码）。 */
const BINARY_SNIFF_BYTES = 8192;

/** 列表条数：缺省 100，封顶 200。 */
function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(200, Math.floor(n));
}

/** 预览的图片类型；非图返回 null（调用方回落文本/二进制分派）。 */
function imageTypeOf(relPath: string): string | null {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/**
 * iframe 预览的类型（html/svg/pdf）。下发真实 content-type 时必须配 `sandbox`
 * 头：项目文件是任意内容，绝不能拿到 dashboard origin——纯 `sandbox`（不带任何
 * allow）= JS 不执行、opaque origin、表单/弹窗全关；CSS 与子资源（img/字体）
 * 照常加载，pdf 的内置 viewer 不受影响。svg 自带 script 的场合尤其靠它。
 */
function iframeTypeOf(relPath: string): string | null {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    default:
      return null;
  }
}

/** 其余二进制（docx/xlsx/zip/…）：不预览，给下载（浏览器转交本地应用打开）。 */
const DOWNLOAD_TYPES: ReadonlySet<string> = new Set([
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'zip',
  'gz',
  'tar',
  'rar',
  '7z',
  'exe',
  'dll',
  'bin',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'ico',
  'mp4',
  'mp3',
  'wav',
  'mov',
]);

function downloadTypeOf(relPath: string): string | null {
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase();
  return DOWNLOAD_TYPES.has(ext) ? 'application/octet-stream' : null;
}

/**
 * 项目文件数据面路由。返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleProjectFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // ---- 项目文件索引：浏览 + 搜索（打开即重建的面，不常驻、不进 DataKey） ----
  const filesMatch = pathname.match(/^\/projects\/(\d+)\/files$/);
  if (filesMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(filesMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }

    // 打开浏览器那一拍带 `fresh=1`：索引立刻重建一次，之后按 git 指纹重验
    const index = await projectFileIndex(project.id, project.path, {
      fresh: url.searchParams.get('fresh') === '1',
    });
    const q = url.searchParams.get('q') ?? '';
    const dir = (url.searchParams.get('dir') ?? '').replace(/^\/+|\/+$/g, '');
    const limit = clampLimit(url.searchParams.get('limit'));

    // 搜索模式：`dir` 子树内按名字模糊匹配，不带 size/mtime（100 条 stat 每键一次太贵）
    if (q.trim()) {
      const { hits, total, capped } = await matchPaths(index, q, limit, dir);
      sendJson(res, 200, {
        root: project.path,
        dir,
        total,
        capped,
        truncated: index.truncated,
        entries: hits.map((h) => ({
          path: h.path,
          name: h.path.slice(h.path.lastIndexOf('/') + 1),
          kind: h.kind,
          ranges: h.ranges,
          ...(index.submodules[h.path] ? { head: index.submodules[h.path] } : {}),
        })),
      });
      return true;
    }

    // 目录浏览模式：直接子项，文件补 size/mtime（≤200 条，一次并行 stat）；
    // 符号链接补 `symlink`（lstat 判条目本体，stat 会穿到目标身上）
    const children = listDirOf(index, dir);
    const entries = await Promise.all(
      children.slice(0, limit).map(async (c) => {
        const base = {
          path: c.path,
          name: c.path.slice(c.path.lastIndexOf('/') + 1),
          kind: c.kind,
          ...(c.head ? { head: c.head } : {}),
        };
        const abs = path.join(project.path, c.path);
        const [ls, ss] = await Promise.all([
          lstat(abs).catch(() => null),
          c.kind === 'file' ? stat(abs).catch(() => null) : Promise.resolve(null),
        ]);
        const sym = ls?.isSymbolicLink() ? { symlink: true } : null;
        if (!ss) return sym ? { ...base, ...sym } : base;
        return { ...base, ...sym, size: ss.size, mtime: ss.mtime.toISOString() };
      }),
    );
    sendJson(res, 200, {
      root: project.path,
      dir,
      total: children.length,
      capped: false,
      truncated: index.truncated,
      entries,
    });
    return true;
  }

  // ---- 项目根内的只读预览：字节流 ----
  // 收窄 = 项目根 containment + 大小上限 + Content-Type 白名单。分派：图片 /
  // iframe 型（html·svg·pdf，恒配 sandbox 头——绝不让项目文件拿到 dashboard
  // origin）/ 下载型（docx 等 octet-stream + attachment，转交本地应用）/ 文本
  // （text/plain 给编辑器）。
  const fileMatch = pathname.match(/^\/projects\/(\d+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(fileMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    let abs: string;
    try {
      abs = resolveWithinProject(project.path, relPath);
    } catch {
      sendJson(res, 403, { error: 'Path escapes the project' });
      return true;
    }
    let info;
    try {
      info = await stat(abs);
    } catch {
      sendJson(res, 404, { error: 'File not found' });
      return true;
    }
    if (!info.isFile()) {
      sendJson(res, 404, { error: 'Not a file' });
      return true;
    }
    if (info.size > PREVIEW_MAX_BYTES) {
      sendJson(res, 413, { error: 'File too large to preview' });
      return true;
    }
    const image = imageTypeOf(relPath);
    const iframe = iframeTypeOf(relPath);
    const download = downloadTypeOf(relPath);
    let bytes = await readFile(abs);
    if (!image && !iframe && !download) {
      // 二进制（NUL 打头那种）不给编辑器：CM 渲出来是一片乱码占位符，不如明说没有预览
      if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        sendJson(res, 415, { error: 'Binary file' });
        return true;
      }
      // 文本按上限截断，且切在行边界上——切在半个字符里会让整段变成替换符
      if (bytes.length > PREVIEW_MAX_TEXT_BYTES) {
        const cut = bytes.subarray(0, PREVIEW_MAX_TEXT_BYTES);
        const nl = cut.lastIndexOf(10);
        bytes = nl > 0 ? cut.subarray(0, nl) : cut;
        res.setHeader('x-weave-truncated', '1');
      }
    }
    if (iframe) res.setHeader('content-security-policy', 'sandbox');
    if (download) {
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURI(path.basename(relPath))}`);
    }
    res.writeHead(200, {
      'content-type': image ?? iframe ?? download ?? 'text/plain; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=60',
    });
    res.end(bytes);
    return true;
  }

  return false;
}
