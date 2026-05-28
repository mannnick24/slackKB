import { createRequire } from "node:module";
import pino from "pino";
import { config } from "./config.js";

const require = createRequire(import.meta.url);

const baseOpts: pino.LoggerOptions = {
  name: "slackkb-api",
  level: config.logging.level,
};

function resolvePinoPrettyTarget(): string | undefined {
  try {
    return require.resolve("pino-pretty");
  } catch {
    return undefined;
  }
}

function createLogger(): pino.Logger {
  const wantPretty = config.logging.pretty && config.logging.level !== "silent";
  const prettyTarget = wantPretty ? resolvePinoPrettyTarget() : undefined;

  if (wantPretty && !prettyTarget) {
    return pino(baseOpts);
  }

  if (prettyTarget) {
    return pino(
      baseOpts,
      pino.transport({
        target: prettyTarget,
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      })
    );
  }

  return pino(baseOpts);
}

/** Root application logger (Pino). Use for code outside Fastify request scope; routes should prefer `req.log`. */
export const logger: pino.Logger = createLogger();
