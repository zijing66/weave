/**
 * 跨机分流（F1）的投递半边：`peer:<name>/<sessionId>` 目标 → 对端
 * `/federation/call` inject。投递器内的一个分支（D8 MessageRouter 特例），
 * 不是新抽象层。请求形状/超时归 federation-client（此处只声明它实现的最小面，
 * 投递器不 import node:https——hooks 层保持无传输依赖）。
 */

/** federation-client.peerRequest 的最小结构面（测试注入同形）。 */
export type PeerRequestLike = (
  peer: { host: string; port: number; fingerprint: string | null },
  req: { method: 'GET' | 'POST'; path: string; body?: unknown; token?: string },
) => Promise<{ ok: boolean; status: number; body: string }>;

/** `peer:<peerName>/<sessionId>` 解析（斜杠后的 sessionId 允许含斜杠吗——
 *  session id 是宿主 UUID，不含斜杠；这里按最后一个 `/` 切，名字先取）。 */
export function parsePeerTarget(toSessionId: string): { peerName: string; sessionId: string } | null {
  const m = toSessionId.match(/^peer:([^/]+)\/(.+)$/);
  if (!m) return null;
  return { peerName: decodeURIComponent(m[1]!), sessionId: m[2]! };
}
