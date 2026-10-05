import type { IncomingMessage, ServerResponse } from 'node:http';

/** Collect the request body into a string. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse the request body as JSON; callers catch parse errors themselves. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readBody(req));
}

/** Write a JSON response with status. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}
