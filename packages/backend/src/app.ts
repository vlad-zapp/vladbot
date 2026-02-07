import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/errorHandler.js";
import { registerAllTools } from "./services/tools/index.js";
import { getSessionFilePath } from "./services/sessionFiles.js";
import { getActiveBrowserSessions } from "./services/tools/browser/connection.js";
import { getSession } from "./services/sessionStore.js";

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

// Active browser sessions for VNC selector
app.get("/api/browser-sessions", async (_req, res) => {
  const sessionIds = getActiveBrowserSessions();
  const sessions = await Promise.all(
    sessionIds.map(async (id) => {
      const session = await getSession(id);
      return {
        id,
        title: session?.title ?? "Unknown",
        createdAt: session?.createdAt ?? null,
      };
    }),
  );
  res.json({ sessions });
});

app.use(errorHandler);

export default app;
