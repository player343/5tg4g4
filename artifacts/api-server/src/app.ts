import type { Options } from "pino-http";
import type { IncomingMessage, ServerResponse } from "http";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pinoHttp = require("pino-http") as (opts: Options) => any;

app.use(
  pinoHttp({
    logger: customLogger,
    serializers: {
      req(req: IncomingMessage & { id?: any }) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);
