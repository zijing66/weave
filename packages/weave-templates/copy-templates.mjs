import { cp, rm } from 'node:fs/promises';
// 先清后拷：删除 src 中已移除的资源不会残留在 dist（cp 只合并不删多余）。
// 内置仓（resources/weave-market）含 .claude-plugin 点目录与 .md/.json/.mjs 非 TS
// 资源，tsc 一概不产出，必须整目录拷。
await rm('dist/resources', { recursive: true, force: true });
await cp('src/resources', 'dist/resources', { recursive: true, force: true });
