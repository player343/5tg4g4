import { Router, type IRouter } from "express";
import healthRouter from "./health";
import valuesRouter from "./values";

const router: IRouter = Router();

router.use(healthRouter);
router.use(valuesRouter);

export default router;
