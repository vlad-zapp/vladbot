import { chromium } from "patchright";

const PROFILE_DIR = process.env.PROFILE_DIR || "/data/profile";
const WIDTH = parseInt(process.env.WIDTH || "1920", 10);
const HEIGHT = parseInt(process.env.HEIGHT || "1080", 10);
const PORT = parseInt(process.env.PW_PORT || "3100", 10);

const server = await chromium.launchServer({
  channel: "chrome",
  headless: false,
  userDataDir: PROFILE_DIR,
  args: [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--start-maximized",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--window-position=0,0`,
  ],
  port: PORT,
  host: "0.0.0.0",
  wsPath: "/",
});

console.log(`Browser server ready`);
console.log(`  WS endpoint: ${server.wsEndpoint()}`);
console.log(`  Profile dir: ${PROFILE_DIR}`);
console.log(`  Viewport:    ${WIDTH}x${HEIGHT}`);

const shutdown = async () => {
  console.log("Shutting down browser server...");
  await server.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
