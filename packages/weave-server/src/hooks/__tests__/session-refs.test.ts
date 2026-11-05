import { describe, it, expect } from 'vitest';
import { referencedSessionIds } from '../session-refs.js';

const A = 'a198b95d-d026-41ab-9a2f-361fe28ce84b';
const B = '63be1cb4-74bd-43c8-a6ba-fc57486bef3f';

describe('referencedSessionIds（输入框 # 引用胶囊的序列化形）', () => {
  it('带名字形 `#<id>「<名>」`', () => {
    expect(referencedSessionIds(`转发给 #${A}「vxspace-a0」 一下`)).toEqual([A]);
  });

  it('裸形 `#<id>`（名字缺席）也认', () => {
    expect(referencedSessionIds(`看看 #${A}`)).toEqual([A]);
  });

  it('多枚引用按出现顺序去重', () => {
    expect(referencedSessionIds(`#${B}「b」 和 #${A}「a」 还有 #${B}「b」`)).toEqual([B, A]);
  });

  it('非 uuid / 非 # 前缀不认', () => {
    expect(referencedSessionIds('#a198b95d 「某会话」 #12345')).toEqual([]);
    expect(referencedSessionIds(`a198b95d-d026-41ab-9a2f-361fe28ce84b`)).toEqual([]);
  });
});
