import { Router } from "express";
import { z } from "zod";
import { putSettings } from "../services/settingsStore.js";
import { getAllRuntimeSettings } from "../config/runtimeSettings.js";

const router = Router();

router.get("/settings", async (_req, res) => {
  const settings = await getAllRuntimeSettings();
  res.json({ settings });
});

const putSchema = z.object({
  settings: z.record(z.string()),
});

router.put("/settings", async (req, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  await putSettings(parsed.data.settings);
  const updated = await getAllRuntimeSettings();
  res.json({ settings: updated });
});

export default router;
