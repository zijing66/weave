/**
 * Standalone daemon entry point, spawned by `weave daemon start`.
 * Runs the daemon in this (detached) process.
 */
import { startDaemon } from './start.js';

startDaemon();
