import { Router } from "express";
import { responseWrapper } from "../../middleware/responseWrapper.js";
import governanceRouter from "./governance.routes.js";

const router = Router();
router.use(responseWrapper);
router.use("/", governanceRouter);

export default router;
