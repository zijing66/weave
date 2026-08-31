/**
 * Development entry point for the CLI.
 *
 * `bin/cli.js` is the published entry and imports from `dist/`; this file
 * mirrors it against `src/` so `tsx watch --conditions=development` can run
 * the CLI without a build step.
 */
import { CLI } from './cli.js';

await new CLI().run();
