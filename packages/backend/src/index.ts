import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import app from "./app.js";
import { env } from "./config/env.js";
import { handleWsConnection } from "./ws/wsServer.js";
import "./ws/handlers.js"; // Register all WS handlers on import

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", handleWsConnection);

server.listen(env.PORT, "0.0.0.0", () => {
  console.log(`Vladbot backend running on http://0.0.0.0:${env.PORT}`);
});

export { server, wss };
