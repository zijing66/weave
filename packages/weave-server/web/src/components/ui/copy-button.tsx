import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/Toast';
import { useT } from '@/i18n/I18nProvider';
import { copyText } from '@/lib/clipboard';

/**
 * 纯图标复制钮：复制成功 1.5s 内换对勾，失败 toast 不静默。
 * `asSpan` = 宿主行自己已是 `<button>`（项目卡那种整卡可点行）——HTML 不许
 * button 套 button，此时降级为 span（role=button 保留可点语义，行为不变）。
 */
export function CopyPathButton({
  path,
  label = 'project.copyPath',
  asSpan = false,
}: {
  path: string;
  label?: string;
  asSpan?: boolean;
}) {
  const t = useT();
  const { show } = useToast();
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent): void => {
    e.stopPropagation();
    void copyText(path).then((ok) => {
      if (!ok) {
        show('error', t('common.copyFailed'));
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const className =
    'pointer-events-auto [&_svg]:pointer-events-none inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-neutral-500 transition-colors hover:text-neutral-200';
  return (
    <Tooltip label={t(label as never)}>
      {asSpan ? (
        <span
          role="button"
          aria-label={t(label as never)}
          onClick={onCopy}
          className={className}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        </span>
      ) : (
        <button type="button" aria-label={t(label as never)} onClick={onCopy} className={className}>
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </Tooltip>
  );
}
