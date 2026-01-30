import { Router } from "express";
import { z } from "zod";
import {
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  getMemoryStats,
} from "../services/memoryStore.js";

const router = Router();

router.get("/memories", async (req, res) => {
  const schema = z.object({
    query: z.string().optional(),
    tags: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    order: z.enum(["newest", "oldest"]).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const tags = parsed.data.tags
    ? parsed.data.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  const result = await listMemories({
    query: parsed.data.query,
    tags,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    order: parsed.data.order,
  });

  res.json(result);
});

router.get("/memories/stats", async (_req, res) => {
  const stats = await getMemoryStats();
  res.json(stats);
});

router.get("/memories/:id", async (req, res) => {
  const memory = await getMemory(req.params.id);
  if (!memory) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(memory);
});

router.post("/memories", async (req, res) => {
  const schema = z.object({
    header: z.string().min(1).max(500),
    body: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    sessionId: z.string().uuid().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const memory = await createMemory(parsed.data);
    res.status(201).json(memory);
  } catch (err) {
    if (err instanceof Error && err.message.includes("storage limit")) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.patch("/memories/:id", async (req, res) => {
  const schema = z
    .object({
      header: z.string().min(1).max(500).optional(),
      body: z.string().min(1).optional(),
      tags: z.array(z.string()).optional(),
    })
    .refine((data) => data.header || data.body || data.tags, {
      message: "At least one field must be provided: header, body, or tags",
    });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const memory = await updateMemory(req.params.id, parsed.data);
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(memory);
  } catch (err) {
    if (err instanceof Error && err.message.includes("storage limit")) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.delete("/memories/:id", async (req, res) => {
  const deleted = await deleteMemory(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.status(204).end();
});

export default router;
