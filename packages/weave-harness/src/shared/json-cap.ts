/**
 * 归一化 payload 的叶子上限（各 harness 的 normalize 共用）。
 *
 * 工具结果正文动辄整份文件（claude 实测库里 64k 行占 557MB，PostToolUse 一条平均
 * 14KB、最大 7MB），而消费方只读开头一截（事件链摘要取 90 字符）+ 几个标量键。
 * 4KB 高于问答预览面的 2000 字符阈值，故不会动到需要保真的字段。
 */
export const MAX_FIELD_CHARS = 4000;
export const MAX_ARRAY_ITEMS = 200;

/** 逐层裁掉超限的字符串叶子与数组尾巴（对象结构原样保留，键不丢）。 */
export function capFields(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(capFields);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capFields(v);
    return out;
  }
  return value;
}
