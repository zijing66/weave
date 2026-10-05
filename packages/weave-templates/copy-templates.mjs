import { cp, rm } from 'node:fs/promises';
// 先清后拷：删除 src 中已移除的模板不会残留在 dist（cp 只合并不删多余）
await rm('dist/templates', { recursive: true, force: true });
await cp('src/templates', 'dist/templates', { recursive: true, force: true });
