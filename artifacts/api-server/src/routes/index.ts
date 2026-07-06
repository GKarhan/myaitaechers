import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import subjectsRouter from "./subjects";
import knowledgeTreeRouter from "./knowledge-tree";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(subjectsRouter);
router.use(knowledgeTreeRouter);

export default router;
