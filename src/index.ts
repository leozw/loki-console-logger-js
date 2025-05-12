import axios from "axios";

interface LokiLoggerOptions {
  url: string;
  tenantId: string;
  authToken?: string;
  appName: string;
  batchSize?: number;
  flushInterval?: number;
  labels?: Record<string, string>;
  dynamicLabels?: Record<string, () => string | number>;
}

let logBuffer: [string, string][] = [];
let flushTimer: NodeJS.Timeout | null = null;
let options: LokiLoggerOptions;

function flushLogs(): void {
  if (logBuffer.length === 0) return;

  const dynamicLabels = options.dynamicLabels
    ? Object.entries(options.dynamicLabels).reduce((acc, [key, fn]) => {
        try {
          acc[key] = String(fn());
        } catch {
          acc[key] = "undefined";
        }
        return acc;
      }, {} as Record<string, string>)
    : {};

  const streams = [
    {
      stream: {
        app: options.appName,
        ...options.labels,
        ...dynamicLabels,
      },
      values: logBuffer.splice(0, logBuffer.length),
    },
  ];

  axios
    .post(
      options.url,
      { streams },
      {
        headers: {
          "X-Scope-OrgID": options.tenantId,
          ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
        },
        timeout: 2000,
      }
    )
    .catch(() => {});
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushLogs();
    flushTimer = null;
  }, options.flushInterval ?? 2000);
}

export function trackEvent(
  eventName: string,
  properties?: Record<string, string | number | boolean>
): void {
  const ts = Date.now() * 1_000_000;
  const eventLog = `[EVENT] ${eventName}`;
  const payload = properties ? JSON.stringify(properties) : "";
  logBuffer.push([`${ts}`, `${eventLog} ${payload}`]);

  const batchSize = options.batchSize ?? 10;
  if (logBuffer.length >= batchSize) {
    flushLogs();
  } else {
    scheduleFlush();
  }
}

export function interceptConsole(config: LokiLoggerOptions): void {
  options = {
    ...config,
    batchSize: config.batchSize ?? 10,
    flushInterval: config.flushInterval ?? 2000,
    labels: config.labels ?? {},
    dynamicLabels: config.dynamicLabels ?? {},
    authToken: config.authToken || "",
  };

  (["log", "info", "warn", "error", "debug"] as const).forEach((method) => {
    const original = console[method];
    console[method] = (...args: unknown[]): void => {
      const message = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");

      const ts = Date.now() * 1_000_000;
      logBuffer.push([`${ts}`, `[${method.toUpperCase()}] ${message}`]);

      const batchSize = options.batchSize ?? 10;
      if (logBuffer.length >= batchSize) {
        flushLogs();
      } else {
        scheduleFlush();
      }

      original.apply(console, args);
    };
  });

  process.on("exit", flushLogs);
  process.on("SIGINT", () => {
    flushLogs();
    process.exit();
  });
  process.on("uncaughtException", (err: Error) => {
    console.error("Uncaught Exception:", err);
    flushLogs();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("Unhandled Rejection:", reason);
    flushLogs();
  });
}
