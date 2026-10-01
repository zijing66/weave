import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { X, FileText } from 'lucide-react';
import { api, type AssetAgent } from '@/lib/api';
import { splitFrontmatter } from '@/lib/markdown';
import { FrontmatterCard } from '@/components/FrontmatterCard';
import { AgentBadge } from '@/components/AgentBadge';
import { useT } from '@/i18n/I18nProvider';

/**
 * Fetches and renders a project file. Markdown files are split into
 * frontmatter (structured card) + rendered body; other files are shown as
 * plain text. Slides into the same right-side slot as the skill drawer.
 */
export function FileViewer({
  projectId,
  relPath,
  global,
  agent,
  onClose,
}: {
  projectId: number;
  relPath: string;
  /** Machine-level file (~/.claude, ~/.codex) — read via the global route. */
  global?: boolean;
  /** Runtime surface of the file — shown as an agent badge when known. */
  agent?: AssetAgent;
  onClose: () => void;
}) {
  const t = useT();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    const req = global ? api.readGlobalFile(relPath) : api.readFile(projectId, relPath);
    req
      .then((f) => setContent(f.content))
      .catch((e) => setError(String(e)));
  }, [projectId, relPath, global]);

  const isMarkdown = relPath.endsWith('.md') || relPath.endsWith('.markdown');
  const parsed = content != null && isMarkdown ? splitFrontmatter(content) : null;

  return (
    <div className="absolute right-0 top-0 h-full w-[min(720px,88%)] z-30 flex flex-col frosted-strong border-l border-white/[0.08] shadow-mac">
      <div className="flex items-center gap-2 p-3 border-b border-white/[0.06]">
        <FileText className="h-4 w-4 shrink-0 text-neutral-500" />
        <span className="text-xs font-mono text-neutral-300 truncate">{relPath}</span>
        {agent && <AgentBadge agent={agent} className="shrink-0" />}
        <button onClick={onClose} className="ml-auto text-neutral-500 hover:text-neutral-300">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {content == null && !error && <p className="text-xs text-neutral-500">{t('common.loading')}</p>}
        {parsed && (
          <>
            {parsed.frontmatter && <FrontmatterCard data={parsed.frontmatter} />}
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {parsed.body}
              </ReactMarkdown>
            </div>
          </>
        )}
        {content != null && !isMarkdown && (
          <pre className="text-xs font-mono text-neutral-300 whitespace-pre-wrap break-all bg-neutral-900 rounded-md p-3 border border-white/[0.06]">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
