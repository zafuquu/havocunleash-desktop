/**
 * Minimal logger shim matching the original's @/main/logging/logger surface
 * (info/warn/error/debug with a component tag).
 */
function emit(level: string, component: string, event: string, details?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] [${component}] ${event}`;
  if (details === undefined) {
    process.stdout.write(`${line}\n`);
    return;
  }
  try {
    process.stdout.write(`${line} ${JSON.stringify(details)}\n`);
  } catch {
    process.stdout.write(`${line}\n`);
  }
}

export const logger = {
  debug: (component: string, event: string, details?: unknown) => emit("debug", component, event, details),
  info: (component: string, event: string, details?: unknown) => emit("info", component, event, details),
  warn: (component: string, event: string, details?: unknown) => emit("warn", component, event, details),
  error: (component: string, event: string, details?: unknown) => emit("error", component, event, details),
};
