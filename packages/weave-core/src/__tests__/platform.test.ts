import { describe, it, expect, vi } from 'vitest';
import { detectPlatform } from '../platform';

describe('detectPlatform', () => {
  it('returns a complete PlatformInfo shape', () => {
    const info = detectPlatform();
    expect(info).toHaveProperty('os');
    expect(info).toHaveProperty('arch');
    expect(info).toHaveProperty('nodeVersion');
    expect(info).toHaveProperty('shell');
    expect(info).toHaveProperty('homeDir');
    expect(info).toHaveProperty('configDir');
  });

  it('reports the current Node version', () => {
    const info = detectPlatform();
    expect(info.nodeVersion).toBe(process.version);
  });

  it('uses the OS platform for the os field', () => {
    const info = detectPlatform();
    const expected = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    expect(info.os).toBe(expected);
  });

  it('infers shell from environment when available', () => {
    vi.stubEnv('SHELL', '/bin/bash');
    const info = detectPlatform();
    // On Linux/macOS, SHELL wins; on Windows it's ignored
    if (info.os !== 'windows') {
      expect(info.shell).toBe('bash');
    }
    vi.unstubAllEnvs();
  });
});
