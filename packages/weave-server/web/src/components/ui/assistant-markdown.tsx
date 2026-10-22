import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownPre } from '@/components/ui/mermaid-block';

/**
 * 会话正文的 Markdown 预览（对话气泡、旁路问答、AI 助手共用一套）：标题 / 粗斜体 /
 * 行内与围栏代码 / 列表 / 引用 / 链接，另挂 `remark-gfm` 只为**表格**（会话总结里
 * 表格常见；顺带拿到删除线、任务列表与裸链接）。仍不挂代码高亮——窄气泡里花花
 * 绿绿反而不好读。表格天生比气泡宽，故由 `table` 组件包一层自身横滚。
 *
 * **字号整体适配气泡**：不用仓内的 `prose`（typography 插件最小档是 prose-sm = 14px，
 * 比对话框正文 12px 大一圈，视觉上明显不配），改为手写紧凑样式——正文锁 `text-xs`、
 * 代码 11px、标题只比正文大半档，行内元素逐项收边距。链接强制新开页签：点一下不能
 * 把 dashboard 导航走。
 *
 * **`memo`**：react-markdown 的解析发生在 render 里，父组件每重渲染一次就重解析
 * 一遍。对话面板里敲一个字就会重渲染整串气泡——长会话下这是「打字/粘贴发卡」的
 * 主要来源，文本没变就不该重解析。
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div
      className={
        'text-xs leading-relaxed text-neutral-200 ' +
        '[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
        '[&_strong]:font-semibold [&_strong]:text-neutral-100 [&_em]:italic ' +
        '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 ' +
        '[&_code]:rounded [&_code]:bg-neutral-950/60 [&_code]:px-1 [&_code]:py-px [&_code]:text-[11px] [&_code]:text-neutral-300 ' +
        '[&_pre]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-edge/[0.06] [&_pre]:bg-neutral-950/60 [&_pre]:p-2 ' +
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11px] ' +
        '[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-[13px] [&_h1]:font-semibold ' +
        '[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold ' +
        '[&_h3]:mt-1.5 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-medium ' +
        '[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-700 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-400 ' +
        '[&_a]:text-blue-400 [&_a]:underline ' +
        '[&_table]:my-0 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[11px] ' +
        '[&_th]:border [&_th]:border-edge/[0.08] [&_th]:bg-neutral-950/40 [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium ' +
        '[&_td]:border [&_td]:border-edge/[0.08] [&_td]:px-1.5 [&_td]:py-1 [&_td]:align-top ' +
        '[&_hr]:my-2 [&_hr]:border-edge/[0.08]'
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: markdownPre,
          table: ({ node: _node, ...props }) => (
            <div className="my-1.5 max-w-full overflow-x-auto">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
