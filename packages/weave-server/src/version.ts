/**
 * The version baked into artifacts weave generates.
 *
 * Kept here rather than read from package.json so every consumer — the
 * statusline script, the helper scripts, the daemon handshake — stamps the
 * same value without each one resolving JSON at runtime.
 *
 * NOTE: bump this alongside package.json when releasing. Deriving it from
 * package.json is the eventual fix (tracked in docs/BACKLOG.md).
 */
export const WEAVE_VERSION = '0.1.0';
