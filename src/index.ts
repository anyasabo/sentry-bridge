import "dotenv/config";
import { app } from "./server";
import { startBridge, stopBridge } from "./bridge";

const port = parseInt(process.env.PORT ?? "3000", 10);

const server = app.listen(port, () => {
  console.log(`sentry-bridge running on port ${port}`);
  startBridge(port).catch((err) =>
    console.error("[bridge] Failed to start:", err)
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[index] Received ${signal} — shutting down`);
  try {
    await stopBridge(server);
  } catch (err) {
    console.error("[index] stopBridge error:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
