import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/errorHandler.js";
import { registerAllTools } from "./services/tools/index.js";
import { getSessionFilePath } from "./services/sessionFiles.js";

registerAllTools();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Health check for monitoring
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// File serving for session screenshots/images (binary data over HTTP)
app.get("/api/sessions/:id/files/:filename", (req, res) => {
  const filePath = getSessionFilePath(req.params.id, req.params.filename);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.sendFile(filePath);
});

app.use(errorHandler);

export default app;
