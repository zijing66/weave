/** 认证词条：登录页与退出按钮（改密只在 CLI，不在此）。 */
export const authZh = {
  'auth.title': 'weave 控制台',
  'auth.passwordPlaceholder': '登录密码',
  'auth.login': '登录',
  'auth.wrongPassword': '密码错误',
  'auth.logout': '退出登录',
  'auth.hint': '初始密码见本机 `weave dashboard` 输出；改密用 `weave chpass <新密码>`（本机执行）。',
  'auth.certDownload': '下载 HTTPS 证书',
  'auth.certHint': '访问本机请用局域网地址；下载后按系统提示装成受信任的 CA。',
};

export const authEn: Record<keyof typeof authZh, string> = {
  'auth.title': 'weave console',
  'auth.passwordPlaceholder': 'Login password',
  'auth.login': 'Log in',
  'auth.wrongPassword': 'Wrong password',
  'auth.logout': 'Log out',
  'auth.hint':
    'The initial password is printed by `weave dashboard` on this machine; change it with `weave chpass <new password>`.',
  'auth.certDownload': 'Download HTTPS certificate',
  'auth.certHint': 'Use the LAN address to reach this host; install the file as a trusted CA.',
};
