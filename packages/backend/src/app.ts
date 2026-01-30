import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health.routes.js";
import modelsRoutes from "./routes/models.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import toolsRoutes from "./routes/tools.routes.js";
import sessionRoutes from "./routes/session.routes.js";
import memoryRoutes from "./routes/memory.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { registerAllTools } from "./services/tools/index.js";

registerAllTools();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.use("/api", healthRoutes);
app.use("/api", modelsRoutes);
app.use("/api", chatRoutes);
app.use("/api", toolsRoutes);
app.use("/api", sessionRoutes);
app.use("/api", memoryRoutes);
app.use("/api", settingsRoutes);

app.use(errorHandler);

export default app;
