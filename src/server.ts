import express from "express";
import path from "path";
import { wizardRouter } from "./routes/wizard";
import { dashboardRouter } from "./routes/dashboard";
import { streamRouter } from "./routes/stream";
import healthRouter from "./routes/health";
import bridgeRouter from "./routes/bridge";
import filesRouter from "./routes/files";
import metricsRouter from "./routes/metrics";

export const app = express();

app.use(express.json());

app.use("/metrics", metricsRouter);
app.use("/api/health", healthRouter);
app.use("/api/wizard", wizardRouter);
app.use("/api/bridge", bridgeRouter);
app.use("/api/files", filesRouter);
app.use("/api", dashboardRouter);
app.use("/", streamRouter);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("*path", (_req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).json({ error: "Not found" });
  });
});
