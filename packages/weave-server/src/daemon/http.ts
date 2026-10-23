import type { IncomingMessage, ServerResponse } from 'node:http';
import { noteRequestBody } from './api-log.js';

/** Collect the request body into a string. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      noteRequestBody(req, text);
      resolve(text);
    });
    req.on('error', reject);
  });
}

/** Parse the request body as JSON; callers catch parse errors themselves. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readBody(req));
}

/**
 * 原始字节（分块上传）：不转字符串（二进制会被 UTF-8 解坏），超上限即断流拒绝。
 * 不走 `noteRequestBody`——请求体日志只记可读文本，二进制分块没有记录价值。
 */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Write a JSON response with status. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}
