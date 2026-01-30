export {
  type Tool,
  registerTool,
  getToolDefinitions,
  executeToolCalls,
  validateToolCalls,
} from "./ToolExecutor.js";

import { registerTool } from "./ToolExecutor.js";
import { filesystemTool } from "./filesystem.js";
import { runCommandTool } from "./runCommand.js";
import { vncTool } from "./vnc/index.js";
import { memoryTool } from "./memory.js";
import { chatHistoryTool } from "./chatHistory.js";
import { visionTool } from "./vision.js";
import { hasVisionModel } from "../ai/toolResultImages.js";

export function registerAllTools(): void {
  registerTool(filesystemTool);
  registerTool(runCommandTool);
  registerTool(vncTool);
  registerTool(memoryTool);
  registerTool(chatHistoryTool);
  if (hasVisionModel()) {
    registerTool(visionTool);
  }
}
