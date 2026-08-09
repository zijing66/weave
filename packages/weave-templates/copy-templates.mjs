import { cp } from 'node:fs/promises';
await cp('src/templates', 'dist/templates', { recursive: true, force: true });
