import type { Options } from "pino-http";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pinoHttp = require("pino-http") as (opts: Options) => any;

app.use(
  pinoHttp({
    logger: customLogger,
    serializers: {
      req(req) {
        return {
          id: (req as any).id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);
