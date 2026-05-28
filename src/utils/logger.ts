export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[90m',
  [LogLevel.INFO]: '\x1b[36m',
  [LogLevel.WARN]: '\x1b[33m',
  [LogLevel.ERROR]: '\x1b[31m',
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: ' INFO',
  [LogLevel.WARN]: ' WARN',
  [LogLevel.ERROR]: 'ERROR',
}

const RESET = '\x1b[0m'

class Logger {
  private level: LogLevel = LogLevel.DEBUG

  setLevel(level: LogLevel) {
    this.level = level
  }

  private log(level: LogLevel, ...args: unknown[]) {
    if (level < this.level) return
    const color = LOG_COLORS[level]
    const label = LEVEL_LABELS[level]
    const timestamp = new Date().toISOString()
    const prefix = `${color}[${timestamp}] [${label}]${RESET}`
    console.log(prefix, ...args)
  }

  debug(...args: unknown[]) { this.log(LogLevel.DEBUG, ...args) }
  info(...args: unknown[]) { this.log(LogLevel.INFO, ...args) }
  warn(...args: unknown[]) { this.log(LogLevel.WARN, ...args) }
  error(...args: unknown[]) { this.log(LogLevel.ERROR, ...args) }

  section(title: string) {
    console.log(`\n\x1b[1m━━━ ${title} ━━━\x1b[0m`)
  }
}

export const logger = new Logger()
