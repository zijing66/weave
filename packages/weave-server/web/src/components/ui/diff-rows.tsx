import type { DiffRow } from '@/lib/text-diff';

/**
 * 逐行 diff 的渲染（配置对照弹窗与会话改动汇总共用）：增行绿、删行红、空档一段省略。
 * 外层的滚动容器与等宽字体归调用方——两处弹窗的框不一样，行本身该长一个样。
 */
export function DiffRows({ rows }: { rows: readonly DiffRow[] }) {
  return (
    <>
      {rows.map((row, idx) =>
        row.kind === 'skip' ? (
          <div key={idx} className="px-3 py-0.5 text-neutral-600 bg-neutral-950/40">
            ⋯ {row.count}
          </div>
        ) : (
          <div
            key={idx}
            className={
              row.kind === 'add'
                ? 'px-3 whitespace-pre-wrap break-all bg-emerald-500/10 text-emerald-200'
                : row.kind === 'del'
                  ? 'px-3 whitespace-pre-wrap break-all bg-red-500/10 text-red-200'
                  : 'px-3 whitespace-pre-wrap break-all text-neutral-400'
            }
          >
            <span className="select-none text-neutral-600">
              {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}
            </span>
            {row.text}
          </div>
        ),
      )}
    </>
  );
}
