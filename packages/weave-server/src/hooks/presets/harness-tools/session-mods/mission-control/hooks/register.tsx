import type { Register } from 'claude-code'

const PANE = 'mission-control'

// 模块级计数：热重载后归零（会话仪表可接受）——精简版只做
// 「state 计数 + Pane/AbovePrompt/status」，不引入 $.state 契约文件。
let sessionCalls = 0
let turnCalls = 0
let lastTool = '-'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.ui.open({ id: PANE, title: 'Mission control' })
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    turnCalls = 0
    $.ui.invalidate()
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    sessionCalls += 1
    turnCalls += 1
    lastTool = String(e.tool)
    $.ui.status(`mc ${sessionCalls}/${turnCalls}`)
    $.ui.invalidate()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold>Mission control</Text>
        <Text>session calls: {sessionCalls}</Text>
        <Text>turn calls: {turnCalls}</Text>
        <Text dimColor>last tool: {lastTool}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>
          mission-control · session {sessionCalls} · turn {turnCalls} · last {lastTool}
        </Text>
      </Box>
    )
  })
}
