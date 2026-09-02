/**
 * Minimal structured logger (JSON lines to stdout for services, or a
 * pluggable sink for extensions running inside an IDE host).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write(line: string): void;
}

const consoleSink: LogSink = {
  write: (line: string) => console.log(line),
};

export interface LoggerOptions {
  service: string;
  sink?: LogSink;
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private readonly service: string;
  private readonly sink: LogSink;
  private readonly level: LogLevel;

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.sink = options.sink ?? consoleSink;
    this.level = options.level ?? "info";
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...fields,
    };
    this.sink.write(JSON.stringify(entry));
  }

  debug(message: string, fields?: Record<string, unknown>) {
    this.log("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>) {
    this.log("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>) {
    this.log("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>) {
    this.log("error", message, fields);
  }

  child(extraFields: Record<string, unknown>): Logger {
    const parentLog = this.log.bind(this);
    const child = new Logger({ service: this.service, level: this.level, sink: this.sink });
    (child as any).log = (level: LogLevel, message: string, fields?: Record<string, unknown>) =>
      parentLog(level, message, { ...extraFields, ...fields });
    return child;
  }
}
