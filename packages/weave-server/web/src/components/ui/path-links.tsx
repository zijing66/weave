import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { errorText } from '@/lib/action-feedback';
import { useToast } from '@/components/Toast';

/** mdast 节点形（本插件只摸这几个字段；不引 @types/mdast）。 */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/**
 * 气泡正文里的路径识别（纯前端，只改渲染不改文本）：remark 插件在 mdast 文本
 * 节点层把裸路径拆成 link 节点（伪协议 `weave-path:<sessionId>:<path>`），`a`
 * 组件里识别该前缀、点击走服务端 `open-path` 按会话 cwd 验证并打开。识别面刻意
 * 收窄——只认「看起来就是个路径」的形状（Windows 盘符 / `~` / POSIX 绝对 /
 * `./`·`../` 相对），普通散文含 `/` 的词不碰；渲染不查存在性——死链照常显示成
 * 路径样子，点了如实 toast，不阻塞渲染。
 *
 * 复制/分享不受影响：它们消费原始 `text`，替换只发生在 markdown 解析树里。
 */

/** 单段路径形状。不裁内部空格（路径含空格是常态），边界靠两侧非路径字符。 */
const PATH_RE = /(?:[A-Za-z]:\\|~\/|\/|\.{1,2}\/)[^\s'"`<>()。，、；：！？]+/g;

/** 结尾标点裁掉：句子收尾的句号/逗号/括号不是路径的一部分。 */
function trimEdge(m: string): { path: string; tail: string } {
  const trimmed = m.replace(/[.,;:'")\]}>…。，、；]+$/, '');
  return { path: trimmed, tail: m.slice(trimmed.length) };
}

/** 伪协议前缀（a 组件据它分流到 openSessionPath）。 */
export const WEAVE_PATH_SCHEME = 'weave-path:';

/** remark 插件工厂：`sessionId` 编进伪协议 url（a 组件点击时取回）。 */
export function remarkPaths(sessionId: string): (tree: unknown) => void {
  const visit = (node: MdNode): void => {
    if (!node || !Array.isArray(node.children)) return;
    const out: MdNode[] = [];
    let changed = false;
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        const value = child.value;
        PATH_RE.lastIndex = 0;
        if (PATH_RE.test(value)) {
          PATH_RE.lastIndex = 0;
          let last = 0;
          for (const m of value.matchAll(PATH_RE)) {
            const idx = m.index ?? 0;
            if (idx > last) out.push({ type: 'text', value: value.slice(last, idx) });
            const { path, tail } = trimEdge(m[0]);
            out.push({
              type: 'link',
              url: `${WEAVE_PATH_SCHEME}${encodeURIComponent(sessionId)}?${encodeURIComponent(path)}`,
              children: [{ type: 'text', value: path }],
            });
            if (tail) out.push({ type: 'text', value: tail });
            last = idx + path.length;
          }
          if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
          changed = true;
          continue;
        }
      }
      // 链接（含 weave-path 自己）与 code 内部不再下钻——链接文字里嵌套没意义
      if (child && child.type !== 'link' && child.type !== 'code' && child.type !== 'inlineCode') {
        visit(child);
      }
      out.push(child);
    }
    if (changed) node.children = out;
  };
  return (tree) => visit((tree ?? { type: 'root' }) as MdNode);
}

/** a 组件：weave-path: 伪协议 → 服务端验证 + 资源管理器打开；其余照常外链。 */
export function PathLinkAnchor(props: Record<string, unknown> & { children?: ReactNode }): ReactNode {
  const href = typeof props.href === 'string' ? props.href : '';
  const { show } = useToast();
  if (!href.startsWith(WEAVE_PATH_SCHEME)) {
    return <a {...props} target="_blank" rel="noreferrer" />;
  }
  const rest = href.slice(WEAVE_PATH_SCHEME.length);
  const q = rest.indexOf('?');
  const sessionId = q >= 0 ? decodeURIComponent(rest.slice(0, q)) : null;
  const path = q >= 0 ? decodeURIComponent(rest.slice(q + 1)) : rest;
  const onClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!sessionId) return;
    void api
      .openSessionPath(sessionId, path)
      .catch((err: unknown) => show('error', errorText(err)));
  };
  return (
    <a href="#" title={path} onClick={onClick}>
      {props.children}
    </a>
  );
}
