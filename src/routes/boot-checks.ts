import { Router } from "express";
import { getBootCheckReport, runAndStoreBootChecks } from "../boot/service";

const router = Router();

router.get("/", (_req, res) => {
  res.json(getBootCheckReport());
});

router.post("/", async (_req, res) => {
  const report = await runAndStoreBootChecks();
  if (!report) {
    res.status(409).json({ message: "Bridge is not configured" });
    return;
  }
  res.json(report);
});

export default router;
