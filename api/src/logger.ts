import pino from "pino";
import { config } from "./config.js";

const baseOpts: pino.LoggerOptions = {
  name: "slackkb-api",
  level: config.logging.level,
};

/** Root application logger (Pino). Use for code outside Fastify request scope; routes should prefer `req.log`. */
export const logger: pino.Logger =
  config.logging.pretty && config.logging.level !== "silent"
    ? pino(
        baseOpts,
        pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        })
      )
    : pino(baseOpts);
