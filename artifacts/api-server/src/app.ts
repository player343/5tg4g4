import pinoHttp, { type Options } from "pino-http";

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
  } satisfies Options)
);
