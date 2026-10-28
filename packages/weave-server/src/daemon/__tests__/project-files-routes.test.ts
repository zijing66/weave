import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { handleProjectFileRoutes } from '../routes/project-files.js';
import { clearFileIndexCache } from '../project-files.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 项目文件数据面路由（project 维度）：`GET /projects/:id/files`（索引浏览 + 搜索）
 * 与 `GET /projects/:id/file`（项目根内只读预览字节流）。重点不是「能取到」，而是
 * **越界的一律拒不**、以及预览绝不下发 text/html。
 */
describe('项目文件数据面路由', () => {
  let db: ReturnType<typeof openDatabase>;
  let root: string;
  let projectPath: string;
  let projectId: number;
  let deps: WeaveServerDeps;

  const call = async (
    path: string,
    body?: unknown,
  ): Promise<{ handled: boolean; status: number; body: unknown; headers: Record<string, string> }> => {
    const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]) as unknown as IncomingMessage;
    req.method = body === undefined ? 'GET' : 'POST';
    let bodyOut: unknown = null;
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      writeHead: (code: number, hdrs?: Record<string, string>) => {
        res.statusCode = code;
        for (const [k, v] of Object.entries(hdrs ?? {})) headers[k.toLowerCase()] = v;
      },
      end: (chunk?: unknown) => {
        bodyOut = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
      },
    };
    const url = new URL(path, 'http://x');
    const handled = await handleProjectFileRoutes(
      req,
      res as unknown as ServerResponse,
      deps,
      url.pathname,
      url,
    );
    return { handled, status: res.statusCode, body: bodyOut, headers };
  };

  const registerProject = (): void => {
    const project = new ProjectRepository(db).register({
      path: projectPath,
      name: 'p',
      token: 'tok',
      source: 'init',
    });
    projectId = project.id;
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'weave-pfiles-'));
    projectPath = join(root, 'proj');
    mkdirSync(join(projectPath, 'src'), { recursive: true });
    writeFileSync(join(projectPath, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectPath, 'page.html'), '<script>alert(1)</script>');
    deps = {
      projects: new ProjectRepository(db),
    } as unknown as WeaveServerDeps;
    clearFileIndexCache();
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('① 列表：直接子项带 size/mtime（表达式不在此面——那是会话域）', async () => {
    registerProject();
    const hit = await call(`/projects/${projectId}/files?dir=src`);
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(200);
    const body = hit.body as { entries: { path: string; kind: string; ref?: string }[] };
    expect(body.entries).toEqual([
      { path: 'src/a.ts', name: 'a.ts', kind: 'file', size: 20, mtime: expect.any(String) },
    ]);
    expect(body.entries[0]!.ref).toBeUndefined();
  });

  it('② 符号链接条目带 symlink 标记（lstat 判本体；普通条目不带）', async () => {
    registerProject();
    symlinkSync(join(projectPath, 'src', 'a.ts'), join(projectPath, 'link.ts'));
    clearFileIndexCache();
    const hit = await call(`/projects/${projectId}/files`);
    const body = hit.body as { entries: { path: string; symlink?: boolean }[] };
    const link = body.entries.find((e) => e.path === 'link.ts')!;
    expect(link.symlink).toBe(true);
    expect(body.entries.find((e) => e.path === 'page.html')!.symlink).toBeUndefined();
  });

  it('③ 嵌套仓目录带 head 短 hash（浏览与搜索都透传）', async () => {
    registerProject();
    const lib = mkdtempSync(join(tmpdir(), 'weave-head-'));
    try {
      execFileSync('git', ['init'], { cwd: lib, stdio: 'ignore' });
      writeFileSync(join(lib, 'a.ts'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: lib, stdio: 'ignore' });
      execFileSync(
        'git',
        ['commit', '-qm', 'init'],
        { cwd: lib, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } },
      );
      execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
      execFileSync(
        'git',
        ['update-index', '--add', '--cacheinfo', '160000,0123456789012345678901234567890123456789,nested'],
        { cwd: projectPath, stdio: 'ignore' },
      );
      cpSync(lib, join(projectPath, 'nested'), { recursive: true });
      clearFileIndexCache();
      const browse = await call(`/projects/${projectId}/files`);
      const browsed = (browse.body as { entries: { path: string; head?: string }[] }).entries.find(
        (e) => e.path === 'nested',
      )!;
      expect(browsed.head).toMatch(/^[0-9a-f]{7}$/);
      const search = await call(`/projects/${projectId}/files?q=nested`);
      const searched = (search.body as { entries: { path: string; head?: string }[] }).entries.find(
        (e) => e.path === 'nested',
      )!;
      expect(searched.head).toBe(browsed.head);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it('④ 搜索模式带上命中区间（前端拿来上色）', async () => {
    registerProject();
    const hit = await call(`/projects/${projectId}/files?q=a.ts`);
    const body = hit.body as { entries: { path: string; ranges?: [number, number][] }[] };
    expect(body.entries[0]!.path).toBe('src/a.ts');
    expect(body.entries[0]!.ranges).toBeDefined();
  });

  it('⑤ 未知项目 404（不是漏到主链）', async () => {
    const hit = await call('/projects/999/files');
    expect(hit.handled).toBe(true);
    expect(hit.status).toBe(404);
  });

  it('⑥ 预览：html 走 iframe 型——真实 content-type + 纯 sandbox 头（origin 不交给项目文件）', async () => {
    registerProject();
    const hit = await call(`/projects/${projectId}/file?path=page.html`);
    expect(hit.status).toBe(200);
    expect(hit.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(hit.headers['content-security-policy']).toBe('sandbox');
    expect(String(hit.body)).toContain('<script>');
  });

  it('⑥b 预览：svg 给 image/svg+xml + sandbox；pdf 给 application/pdf + sandbox', async () => {
    registerProject();
    writeFileSync(join(projectPath, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(projectPath, 'doc.pdf'), '%PDF-1.4 fake');
    const svg = await call(`/projects/${projectId}/file?path=pic.svg`);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['content-security-policy']).toBe('sandbox');
    const pdf = await call(`/projects/${projectId}/file?path=doc.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-security-policy']).toBe('sandbox');
  });

  it('⑥c 预览：下载型（docx 等）给 octet-stream + attachment，不嗅探不 415', async () => {
    registerProject();
    writeFileSync(join(projectPath, 'r.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1]));
    const hit = await call(`/projects/${projectId}/file?path=r.docx`);
    expect(hit.status).toBe(200);
    expect(hit.headers['content-type']).toBe('application/octet-stream');
    expect(hit.headers['content-disposition']).toContain('attachment');
    expect(hit.headers['content-disposition']).toContain('r.docx');
  });

  it('⑦ 预览：图片按扩展名给 content-type', async () => {
    registerProject();
    writeFileSync(join(projectPath, 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const hit = await call(`/projects/${projectId}/file?path=dot.png`);
    expect(hit.status).toBe(200);
    expect(hit.headers['content-type']).toBe('image/png');
  });

  it('⑧ 越界路径 403：绝对路径、.. 都拒', async () => {
    registerProject();
    expect((await call(`/projects/${projectId}/file?path=../outside.txt`)).status).toBe(403);
    expect((await call(`/projects/${projectId}/file?path=${encodeURIComponent('D:/Windows/win.ini')}`)).status).toBe(403);
  });

  it('⑨ 不存在 404、缺参数 400、目录 404', async () => {
    registerProject();
    expect((await call(`/projects/${projectId}/file?path=src/nope.ts`)).status).toBe(404);
    expect((await call(`/projects/${projectId}/file`)).status).toBe(400);
    expect((await call(`/projects/${projectId}/file?path=src`)).status).toBe(404);
  });

  it('⑩ 二进制（含 NUL、不在下载清单）不给编辑器：415', async () => {
    registerProject();
    writeFileSync(join(projectPath, 'blob.dat'), Buffer.from([1, 2, 0, 3]));
    const hit = await call(`/projects/${projectId}/file?path=blob.dat`);
    expect(hit.status).toBe(415);
  });

  it('⑪ 文本超 1MB 截断（切在行边界，不劈半个字符），带 x-weave-truncated 头', async () => {
    registerProject();
    const line = 'x'.repeat(99) + '\n';
    writeFileSync(join(projectPath, 'big.txt'), line.repeat(12_000)); // ~1.2MB
    const hit = await call(`/projects/${projectId}/file?path=big.txt`);
    expect(hit.status).toBe(200);
    expect(hit.headers['x-weave-truncated']).toBe('1');
    const text = String(hit.body);
    expect(text.length).toBeLessThan(1024 * 1024);
    // 切点 = 1MB 内最后一个 LF：内容不劈字符（末字节是完整的行内字符，LF 本身被切掉）
    expect(text.length).toBeGreaterThan(1024 * 1024 - 200);
  });
});
