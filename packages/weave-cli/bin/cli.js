#!/usr/bin/env node
import { CLI } from '../dist/index.js';
const cli = new CLI();
await cli.run();
