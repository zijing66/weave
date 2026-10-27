import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ImagesSurface, PromptImage, PromptImageSet } from '../driver.js';

/**
 * 入站图（codex）：用户在**终端输入框**里贴的图，hook 载荷的 `prompt` 只有
 * `[Image #N]` 占位文本（composer 的占位元素就是 textarea 文本的一部分，提交时
 * 原样进 `UserInput::Text`），图本身只在 rollout 里——`item_completed` 的
 * `UserMessage` 条目 `content[]` 带 `{type:'image', image_url:'data:...;base64,...'}`
 * （`UserInput::Image` + untagged `ImageReference::Inline` 的 serde 形状）。
 *
 * 只认顶层图项：`function_call_output` 里的 `input_image`（view_image 等工具的
 * 回执）不是「人贴的图」，混进来会在对话气泡上凭空多出图。
 */

/** 能进 uploads 的四种类型（与 server 的 `UPLOAD_MEDIA_TYPES` 同一集合）。 */
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 单张上限：与 server 的上传上限对齐，超了不搬。 */
const MAX_BYTES = 10 * 1024 * 1024;

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** 一条 content 数组里的图（认不出的项跳过）。 */
function imagesOf(content: unknown): PromptImage[] {
  if (!Array.isArray(content)) return [];
  const out: PromptImage[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    if (part.type !== 'image') continue;
    const url = typeof part.image_url === 'string' ? part.image_url : null;
    if (!url) continue;
    const m = DATA_URL.exec(url);
    if (!m) continue;
    const mediaType = m[1]!;
    if (!MEDIA_TYPES.has(mediaType)) continue;
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_BYTES) continue;
    out.push({ mediaType, bytes });
  }
  return out;
}

/** 同一条消息的正文（Text 项拼接；占位记号在其中，与 hook 载荷的 prompt 同源）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) =>
      raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'text'
        ? String((raw as Record<string, unknown>).text ?? '')
        : '',
    )
    .join('');
}

export const CODEX_IMAGES: ImagesSurface = {
  async sessionImages({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: PromptImageSet[] = [];
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        // 预筛：带 data URL 图的行才值得 parse（rollout 动辄几十 MB）
        if (!line.includes('"type":"image"')) continue;
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== 'event_msg') continue;
        const payload = entry.payload as Record<string, unknown> | undefined;
        if (payload?.type !== 'item_completed') continue;
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type !== 'UserMessage') continue;
        const content = item.content;
        const images = imagesOf(content);
        if (images.length === 0) continue;
        out.push({
          text: textOf(content),
          at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
          images,
        });
      }
    } catch {
      return null;
    } finally {
      rl.close();
    }
    return out;
  },
};
