import { cp } from 'node:fs/promises';
// tsc 只编译 .ts：内置预设插件（manifest/rules/prompts）需手工拷进 dist。
await cp('src/hooks/presets', 'dist/hooks/presets', { recursive: true, force: true });
