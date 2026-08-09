import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, formatTable } from '../utils/logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('logs info to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('hello');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'));
  });

  it('logs success to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.success('done');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('done'));
  });

  it('logs warn to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.warn('careful');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('careful'));
  });

  it('logs error to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('respects NO_COLOR env by emitting plain text', () => {
    vi.stubEnv('NO_COLOR', '1');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('plain');
    expect(spy).toHaveBeenCalledWith('plain');
    vi.unstubAllEnvs();
  });
});

describe('formatTable', () => {
  it('aligns two columns', () => {
    const out = formatTable([['a', '1'], ['longer', '22']]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}a {7}1$/);
  });

  it('returns empty string for no rows', () => {
    expect(formatTable([])).toBe('');
  });
});
