import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultLogger, resolveLogger } from '../../utils/logger'

describe('resolveLogger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('defaults to console warn/error and silences debug/info', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = resolveLogger()
    expect(logger).toBe(defaultLogger)
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    expect(log).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[firetap]', 'w')
  })

  it('uses the provided methods and no-ops the missing ones', () => {
    const debug = vi.fn()
    const logger = resolveLogger({ debug })
    logger.debug('x', 1)
    expect(debug).toHaveBeenCalledWith('x', 1)
    expect(() => logger.error('ignored')).not.toThrow()
  })

  it('accepts console itself', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    resolveLogger(console).debug('hi')
    expect(debug).toHaveBeenCalledWith('hi')
  })
})
