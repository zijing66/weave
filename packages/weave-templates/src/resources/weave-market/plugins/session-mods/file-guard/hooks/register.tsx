import type { Register } from 'claude-code'

// 敏感路径：.env / .env.*、secrets/、PEM 私钥、SSH 私钥。
const PROTECTED = /(^|\/)\.env(\.|$)|(^|\/)secrets(\/|$)|\.pem$|(^|\/)id_(rsa|ed25519)(\.|$)/

// 高危 Bash 模式：递归强删根/家目录、force push、格式化/整盘写、fork 炸弹。
const DANGEROUS =
  /(^|\s)rm\s+-r[f]*\s+(\/|~|\$HOME)(\s|$)|git\s+push\s+([^&|;]*\s(-f|--force)\b)|mkfs|dd\s+if=|:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/

function deny($: { plugin: { name: string }; ui: { toast(t: string): void } }, reason: string) {
  const text = `${$.plugin.name}: ${reason}`
  $.ui.toast(text)
  return { deny: text }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    PROTECTED.test(e.file_path)
      ? deny($, `已拦截对 ${e.file_path} 的编辑（敏感文件受保护）`)
      : next(e),
  )

  on('tool.call', { tool: 'Write' }, ($, e, next) =>
    PROTECTED.test(e.file_path)
      ? deny($, `已拦截对 ${e.file_path} 的写入（敏感文件受保护）`)
      : next(e),
  )

  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    DANGEROUS.test(e.command)
      ? deny($, `已拦截高危命令：${e.command.slice(0, 80)}`)
      : next(e),
  )
}
