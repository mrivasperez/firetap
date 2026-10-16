export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const noop = () => {};

export const defaultLogger: Logger = {
  debug: noop,
  info: noop,
  warn: (...args) => console.warn("[firetap]", ...args),
  error: (...args) => console.error("[firetap]", ...args),
};

export function resolveLogger(logger?: Partial<Logger>): Logger {
  if (!logger) return defaultLogger;
  return {
    debug: logger.debug?.bind(logger) ?? noop,
    info: logger.info?.bind(logger) ?? noop,
    warn: logger.warn?.bind(logger) ?? noop,
    error: logger.error?.bind(logger) ?? noop,
  };
}
