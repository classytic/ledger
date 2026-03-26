import { describe, it, expect, vi } from 'vitest';
import { defaultLogger } from '../../src/utils/logger.js';
import type { Logger } from '../../src/utils/logger.js';

describe('defaultLogger', () => {
  it('implements Logger interface', () => {
    expect(typeof defaultLogger.warn).toBe('function');
    expect(typeof defaultLogger.error).toBe('function');
    expect(typeof defaultLogger.info).toBe('function');
  });

  it('warn() calls console.warn with prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defaultLogger.warn('test warning');
    expect(spy).toHaveBeenCalledWith('[accounting] test warning', '');
    spy.mockRestore();
  });

  it('error() calls console.error with prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    defaultLogger.error('test error');
    expect(spy).toHaveBeenCalledWith('[accounting] test error', '');
    spy.mockRestore();
  });

  it('info() calls console.info with prefix', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    defaultLogger.info('test info');
    expect(spy).toHaveBeenCalledWith('[accounting] test info', '');
    spy.mockRestore();
  });

  it('passes metadata when provided', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meta = { key: 'value' };
    defaultLogger.warn('with meta', meta);
    expect(spy).toHaveBeenCalledWith('[accounting] with meta', meta);
    spy.mockRestore();
  });

  it('satisfies the Logger type contract', () => {
    const logger: Logger = defaultLogger;
    expect(logger).toBeDefined();
  });
});
