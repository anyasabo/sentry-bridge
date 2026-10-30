import { Router } from "express";
import { metricsRegistry } from "../lib/metrics";

const router = Router();

// Prometheus scrape target
router.get("/", async (_req, res) => {
  res.set("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

export default router;
