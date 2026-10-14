import { useState } from 'react';
import { Lock } from 'lucide-react';
import { AuthError, login } from '@/lib/auth';
import { useT } from '@/i18n/I18nProvider';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { FeedbackIcon } from '@/components/FeedbackIcon';

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
    <div className="grid min-h-dvh place-items-center bg-neutral-950 px-4">
      <form
        className="w-full max-w-xs rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mb-5 flex items-center gap-2 text-neutral-200">
          <Lock className="h-4 w-4 text-neutral-500" />
          <span className="text-sm font-medium">{t('auth.title')}</span>
        </div>
        {/* 登录凭据的**唯一**归属框：current-password 让浏览器把保存的密码稳定填这里；
            设置里的 API key 输入已标为非凭据（见 SettingsModal），两者不再互抢。 */}
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
          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={state === 'loading' || password === ''}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          <FeedbackIcon state={state} />
          {t('auth.login')}
        </button>
        <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">{t('auth.hint')}</p>
      </form>
    </div>
  );
}
