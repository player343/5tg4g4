import express, { type Express } from "express";
import cors from "cors";
import pinoHttp = require("pino-http");

import type { Request, Response } from "express";

import router from "./routes";
import { logger as customLogger } from "./lib/logger";

const app: Express = express();

const logger = pinoHttp();

app.use(
  pinoHttp({
    logger: customLogger,
    serializers: {
      req(req: Request) {
        return {
          id: (req as any).id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: Response) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
