import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ImagesSurface, PromptImage, PromptImageSet } from '../driver.js';

/**
 * 入站图（claude）：用户在**终端输入框**里粘的图，hook 载荷只有一个 `[Image #N]`
 * 占位记号，图本身只在转录里——user 条目的 `message.content[]` 带
 * `{type:'image', source:{type:'base64', media_type, data}}`。
 *
 * 只认顶层 image 块：工具结果里的图（`tool_result.content[].image`）和子代理回执
 * 都不是「人粘贴的图」，混进来会在对话气泡上凭空多出图。
 */

/** 能进 uploads 的四种类型（与 server 的 `UPLOAD_MEDIA_TYPES` 同一集合）。 */
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 单张上限：与 server 的上传上限对齐，超了不搬（host 的粘贴缓存也是这个量级）。 */
const MAX_BYTES = 10 * 1024 * 1024;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** 一条 user 条目的图块（认不出的块跳过）。 */
function imagesOf(content: unknown): PromptImage[] {
  if (!Array.isArray(content)) return [];
  const out: PromptImage[] = [];
  for (const raw of content) {
    const part = obj(raw);
    if (part.type !== 'image') continue;
    const source = obj(part.source);
    const mediaType = typeof source.media_type === 'string' ? source.media_type : null;
    const data = typeof source.data === 'string' ? source.data : null;
    if (!mediaType || !data || !MEDIA_TYPES.has(mediaType)) continue;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_BYTES) continue;
    out.push({ mediaType, bytes });
  }
  return out;
}

/** 同一条消息的正文（宿主把输入框原文逐段写在这里，占位记号也在其中）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(obj)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

export const CLAUDE_IMAGES: ImagesSurface = {
  async sessionImages({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: PromptImageSet[] = [];
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        // 预筛：带 base64 图块的行才值得 parse（转录动辄几十 MB）
        if (!line.includes('"type":"image"')) continue;
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== 'user') continue;
        // 工具结果的回执也记成 user 条目（带 toolUseResult）：那里面的图不是人贴的
        if (entry.toolUseResult != null) continue;
        const content = obj(entry.message).content;
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
