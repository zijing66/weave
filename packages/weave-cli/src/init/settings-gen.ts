/**
 * settings.json 生成器已迁 `@weavecode/harness`（claude 专属表示法，daemon 的
 * init 文件漂移检测也要用同一份）；此处 re-export 保持存量 import 与测试零改动。
 */
export {
  generateSettingsJson,
  mergeSettingsJson,
  stripWeaveSettings,
  type SettingsGeneratorInput,
} from '@weavecode/harness';
