type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function write(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** JSON-lines logger. `debug` is emitted only when `LOG_LEVEL=debug`. */
export const log = {
  debug: (msg: string, fields?: Fields) => {
    if (process.env.LOG_LEVEL === "debug") write("debug", msg, fields);
  },
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

export function errorFields(err: unknown): Fields {
  return err instanceof Error ? { error: err.name, errorMessage: err.message } : { error: err };
}
