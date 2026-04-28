import express, { type Express } from "express";
import cors from "cors";
import * as pinoHttp from "pino-http";
import type { Request, Response } from "express";

import router from "./routes";
import { logger as customLogger } from "./lib/logger";

const app: Express = express();

// FIXED pino-http init (Vercel-safe)
const logger = (pinoHttp as any).default?.() ?? (pinoHttp as any)();

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
