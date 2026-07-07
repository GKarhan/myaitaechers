import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import dashboardRouter from "./dashboard";
import subjectsRouter from "./subjects";
import knowledgeTreeRouter from "./knowledge-tree";
import lessonsRouter from "./lessons";
import chatRouter from "./chat";
import booksRouter from "./books";
import homeworkRouter from "./homework";
import progressRouter from "./progress";
import adminRouter from "./admin";
import teacherRouter from "./teacher";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(subjectsRouter);
router.use(knowledgeTreeRouter);
router.use(lessonsRouter);
router.use(chatRouter);
router.use(booksRouter);
router.use(homeworkRouter);
router.use(progressRouter);
router.use(adminRouter);
router.use(teacherRouter);

export default router;
