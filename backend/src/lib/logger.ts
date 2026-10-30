// One-line JSON logs, so Render's log viewer can be searched by field.
type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function write(level: Level, msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};
