import { Router } from "express";
import { getToolDefinitions } from "../services/tools/index.js";

const router = Router();

router.get("/tools", (_req, res) => {
  res.json({
    definitions: getToolDefinitions(),
  });
});

export default router;
