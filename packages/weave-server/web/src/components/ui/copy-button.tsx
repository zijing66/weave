import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/Toast';
import { useT } from '@/i18n/I18nProvider';
import { copyText } from '@/lib/clipboard';

/** 纯图标复制钮：复制成功 1.5s 内换对勾，失败 toast 不静默。 */
export function CopyPathButton({ path, label = 'project.copyPath' }: { path: string; label?: string }) {
  const t = useT();
  const { show } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={t(label as never)}>
      <button
        type="button"
        aria-label={t(label as never)}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(path).then((ok) => {
            if (!ok) {
              show('error', t('common.copyFailed'));
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="pointer-events-auto [&_svg]:pointer-events-none inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:text-neutral-200"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </Tooltip>
  );
}
