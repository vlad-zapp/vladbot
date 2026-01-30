import { Router } from "express";
import { AVAILABLE_MODELS } from "@vladbot/shared";
import { env } from "../config/env.js";

const router = Router();

const providerKeyMap: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GOOGLE_GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

router.get("/models", (_req, res) => {
  const models = AVAILABLE_MODELS.filter((m) => {
    const key = providerKeyMap[m.provider];
    return key ? !!env[key as keyof typeof env] : false;
  });
  res.json(models);
});

export default router;
