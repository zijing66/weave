import { describe, it, expect } from 'vitest';
import { webTerminalAvailabilityOf, openTerminalStateOf } from '../conv-model';

/**
 * 会话行终端按钮（webMode）的可用性判据回归：live（有活实例 = 进 TUI）/
 * resume（没跑但转录在 = 点了就地恢复，留在对话面等再点）/ busy（跑在外部
 * 终端 = 置灰说明）/ gone（转录没了）。纯表驱动，同 conv-model 的先例。
 */
describe('webTerminalAvailabilityOf（webMode 终端按钮可用性）', () => {
  it('有活实例 = live（不管进程/转录怎么报——实例本身就是「能接上」的证据）', () => {
    expect(webTerminalAvailabilityOf({ webInstanceId: 'inst-1' })).toBe('live');
    expect(webTerminalAvailabilityOf({ webInstanceId: 'inst-1', pidAlive: false })).toBe('live');
  });

  it('没实例、进程活着 = busy（在外部终端里跑，Web 终端接不过来）', () => {
    expect(webTerminalAvailabilityOf({ pidAlive: true })).toBe('busy');
  });

  it('没实例、进程死了但转录在 = resume（点了就地恢复，停在对话面）', () => {
    expect(webTerminalAvailabilityOf({ pidAlive: false, transcriptPresent: true })).toBe('resume');
    expect(webTerminalAvailabilityOf({})).toBe('resume');
  });

  it('转录没了 / 服务端判 resume 不可用 = gone（置灰并说明）', () => {
    expect(webTerminalAvailabilityOf({ pidAlive: false, transcriptPresent: false })).toBe('gone');
    expect(webTerminalAvailabilityOf({ pidAlive: false, canOpenTerminal: false })).toBe('gone');
  });

  it('busy 优先于 gone：进程还活着时先说「关掉那个终端」', () => {
    expect(webTerminalAvailabilityOf({ pidAlive: true, transcriptPresent: false })).toBe('busy');
  });
});

describe('openTerminalStateOf（本地点击反馈 vs 服务端拉起态合成）', () => {
  it('本地在途（loading/success）优先——用户刚点过的反馈不能被 opening 盖掉', () => {
    expect(openTerminalStateOf('loading', true)).toBe('loading');
    expect(openTerminalStateOf('success', false)).toBe('success');
  });

  it('本地 idle 才看服务端拉起态（message.opening 帧的 ensureOpen 窗口）', () => {
    expect(openTerminalStateOf('idle', true)).toBe('loading');
    expect(openTerminalStateOf('idle', false)).toBe('idle');
  });
});
