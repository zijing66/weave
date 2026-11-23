import { describe, expect, it } from 'vitest';
import {
  HARNESS_COMPACTION as CORE_COMPACTION,
  HARNESS_DIRS,
  HARNESS_LIFECYCLE as CORE_LIFECYCLE,
  HARNESS_SESSION_CONTROL as CORE_SESSION_CONTROL,
} from '@weavecode/core/harness';
import { HARNESS_COMPACTION, HARNESS_LIFECYCLE, HARNESS_SESSION_CONTROL } from '../lifecycle';
import { HARNESS_UI } from '@/lib/harness-meta';

/**
 * 镜像漂移闸（盲评 A 批发现）：web 运行时不能 import core 值（import type 纪律），
 * lifecycle.ts / harness-meta.tsx 各持一份手工镜像——本测试**测试态**直接引 core
 * 原表逐键比对，core 表一改这里即红，镜像不再靠「改那边同步这里」的人肉自觉。
 */
describe('web 镜像表与 core 原表一致（漂移闸）', () => {
  it('HARNESS_LIFECYCLE 逐键一致', () => {
    expect(HARNESS_LIFECYCLE).toEqual(CORE_LIFECYCLE);
  });

  it('HARNESS_COMPACTION 逐键一致', () => {
    expect(HARNESS_COMPACTION).toEqual(CORE_COMPACTION);
  });

  it('HARNESS_SESSION_CONTROL 逐键一致', () => {
    expect(HARNESS_SESSION_CONTROL).toEqual(CORE_SESSION_CONTROL);
  });

  it('harness-meta dotDir 与 core HARNESS_DIRS.projectDir 一致', () => {
    for (const [harness, dirs] of Object.entries(HARNESS_DIRS)) {
      expect(HARNESS_UI[harness as keyof typeof HARNESS_UI]?.dotDir).toBe(dirs.projectDir);
    }
  });
});
