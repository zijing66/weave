import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { AuthError, login } from '@/lib/auth';
import { useT } from '@/i18n/I18nProvider';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { Tooltip } from '@/components/ui/tooltip';
import { WeaveMark } from '@/components/WeaveLogo';

/**
 * 仅密码登录页（无用户名、**无改密入口**——改密只走 CLI `weave chpass <新密码>`）。
 * 反馈沿仓内口径：按钮三态 + 失败不静默（错密码 toast 本地化文案，不透服务端英文）。
 */
export function LoginPage() {
  const t = useT();
  const fb = useActionFeedback();
  const [password, setPassword] = useState('');
  const state = fb.stateOf('login');

  const submit = (): void => {
    if (!password) return;
    void fb.run(
      'login',
      async () => {
        await login(password);
      },
      {
        fail: (e) =>
          e instanceof AuthError && e.status === 401 ? t('auth.wrongPassword') : errorText(e),
      },
    );
  };

  return (
    <div className="grid h-full place-items-center bg-neutral-950 px-4">
      <form
        className="w-full max-w-xs rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mb-5 flex items-center gap-2 text-neutral-200">
          {/* 品牌标记：与顶栏 / favicon 同一份图形（WeaveMark），单一来源 */}
          <WeaveMark className="h-[15px] w-auto" />
          <span className="text-sm font-medium">{t('auth.title')}</span>
        </div>
        {/* 登录凭据的**唯一**归属框：current-password 让浏览器把保存的密码稳定填这里；
            设置里的 API key 输入已标为非凭据（见 SettingsModal），两者不再互抢。 */}
        <div className="relative">
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            name="weaveDashboardPassword"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('auth.passwordPlaceholder')}
            className="w-full rounded-lg border border-neutral-800 bg-neutral-950 py-2 pl-3 pr-9 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
          {/* chpass 提示收进「?」：图标与输入框行同高（py-2 行内垂直居中） */}
          <Tooltip label={t('auth.hint')} side="bottom" className="absolute right-2 top-1/2 -translate-y-1/2">
            <span
              role="img"
              aria-label={t('auth.hint')}
              className="flex h-5 w-5 cursor-help items-center justify-center text-neutral-600 transition-colors hover:text-neutral-400"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </span>
          </Tooltip>
        </div>
        <button
          type="submit"
          disabled={state === 'loading' || password === ''}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 disabled:opacity-50"
        >
          <FeedbackIcon state={state} />
          {t('auth.login')}
        </button>
      </form>
    </div>
  );
}
