import type { RpgHexagon } from '@/lib/api';

/**
 * 成长榜读面派生（E1）：六维总和。E2 在做 XP/等级数值深化——基线里还没有等级
 * 派生面，这里先消费既有六维读面；E2 的派生面落地后换键（成长榜排序键收口
 * 在这一处，换键零散改）。
 */
export function hexagonSum(hex: RpgHexagon): number {
  return hex.力量 + hex.智慧 + hex.敏捷 + hex.速度 + hex.内力 + hex.运气;
}
