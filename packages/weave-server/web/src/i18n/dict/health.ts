/** 项目健康徽标词条（批 8）：按 core 返回的 check id 渲染失败项文案。 */
export const healthZh = {
  'health.badgeTip': '{count} 项健康检查未通过',
  'health.okTip': '健康检查全部通过',
  'health.check.instructionLinkNotMaterialised': '{agents} 是内容为 "{claude}" 的普通文件——git 把软链接检出成了文本。',
  'health.check.instructionFilesDuplicated': '{claude} 与 {agents} 都是独立文件——两者内容会各自漂移。',
  'health.check.instructionLinkDangling': '{name} 是目标不存在的软链接。',
  'health.check.statuslinePathUnresolved': 'statusLine 命令无法解析出脚本路径：{command}',
  'health.check.statuslinePathForeign': 'statusLine 指向本项目之外（{path}）——它是为另一个检出生成的。',
  'health.check.statuslineScriptMissing': 'statusLine 脚本缺失：{path}',
};

export const healthEn: Record<keyof typeof healthZh, string> = {
  'health.badgeTip': '{count} health check(s) failing',
  'health.okTip': 'All health checks passing',
  'health.check.instructionLinkNotMaterialised':
    '{agents} is a plain file containing "{claude}" — git checked the symlink out as text.',
  'health.check.instructionFilesDuplicated':
    '{claude} and {agents} are both regular files — they will drift apart.',
  'health.check.instructionLinkDangling': '{name} is a symlink whose target does not exist.',
  'health.check.statuslinePathUnresolved':
    'statusLine command does not resolve to a script path: {command}',
  'health.check.statuslinePathForeign':
    'statusLine points outside this project ({path}) — it was generated for another checkout.',
  'health.check.statuslineScriptMissing': 'statusLine script is missing: {path}',
};
