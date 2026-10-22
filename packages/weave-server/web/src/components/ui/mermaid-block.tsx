import {
  isValidElement,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useTheme } from '@/lib/theme';
import { renderMermaidSvg } from '@/lib/mermaid';

/**
 * ```mermaid 围栏的图渲染（加载器与消毒口径都在 `lib/mermaid`，导出图片共用同一份）。
 * 渲染失败就把源码照原样摆着（错误原因附在标题上），绝不装作图在那儿。
 */
export function MermaidBlock({ code }: { code: string }) {
  const t = useT();
  const theme = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setError(null);
    renderMermaidSvg(code, theme)
      .then((out) => {
        if (alive) setSvg(out);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [code, theme]);

  return (
    <div className="my-1.5 overflow-hidden rounded border border-edge/[0.08] bg-neutral-950/40">
      <div className="flex items-center gap-2 border-b border-edge/[0.06] px-2 py-1">
        <span className="text-[10px] font-medium text-neutral-500">mermaid</span>
        {error && (
          <span title={error} className="truncate text-[10px] text-red-400">
            {t('common.mermaidFailed')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setSource((v) => !v)}
          className="ml-auto shrink-0 rounded border border-edge/[0.1] px-1.5 py-px text-[10px] text-neutral-400 hover:text-neutral-200"
        >
          {source ? t('common.mermaidShowChart') : t('common.mermaidShowSource')}
        </button>
      </div>
      {source || (error && !svg) ? (
        <pre className="m-0 max-w-full overflow-x-auto p-2 text-[11px] text-neutral-300">{code}</pre>
      ) : svg ? (
        <div
          className="max-w-full overflow-x-auto p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // mermaid 在 strict 档下已过滤过 HTML/脚本
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="p-2 text-[11px] text-neutral-600">{t('common.mermaidRendering')}</div>
      )}
    </div>
  );
}

/** react-markdown 的 `pre` 覆盖：语言标记为 mermaid 的围栏交给 {@link MermaidBlock}，
 *  其余原样（样式仍由外层 `[&_pre]` 类吃）。两处 markdown 面（对话气泡 / 文件预览）
 *  共用这一份，避免各写一遍围栏解析。 */
export function markdownPre({
  node: _node,
  children,
  ...props
}: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const { lang, text } = fenceOf(children);
  if (lang === 'mermaid') return <MermaidBlock code={text} />;
  return <pre {...props}>{children}</pre>;
}

/** `pre` 的唯一子节点（`code`）的语言与正文。 */
function fenceOf(children: ReactNode): { lang: string | null; text: string } {
  const first = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(first)) return { lang: null, text: '' };
  const props = first.props as { className?: unknown; children?: ReactNode };
  const className = typeof props.className === 'string' ? props.className : '';
  return { lang: /language-([\w-]+)/.exec(className)?.[1] ?? null, text: plainText(props.children) };
}

function plainText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (isValidElement(node)) return plainText((node.props as { children?: ReactNode }).children);
  return '';
}
