type LogValue = string | number | boolean | null | undefined;

export class Logger {
  readonly #fields: Record<string, LogValue>;

  constructor(event: string, fields: Record<string, LogValue> = {}) {
    this.#fields = { event, ...fields };
  }

  child(fields: Record<string, LogValue>): Logger {
    return new Logger(String(this.#fields.event), { ...this.#fields, ...fields });
  }

  info(fields: Record<string, LogValue> = {}): void {
    console.log(JSON.stringify({ ...this.#fields, ...fields, level: "info" }));
  }

  warn(fields: Record<string, LogValue> = {}): void {
    console.warn(JSON.stringify({ ...this.#fields, ...fields, level: "warn" }));
  }

  error(fields: Record<string, LogValue> = {}): void {
    console.error(JSON.stringify({ ...this.#fields, ...fields, level: "error" }));
  }
}
