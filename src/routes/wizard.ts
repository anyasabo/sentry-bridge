import { Router } from "express";
import { createPrusaLinkClient } from "../prusalink/client";
import { createCamera } from "../camera/camera";
import { Config, isConfigured, tryLoadConfig } from "../config/config";
import { mergeStoredSecrets, SecretFallbackError } from "../config/secrets";
import { resolveSetup, saveSetup, SetupError } from "./setup";
import { createObicoAgent } from "../obico/agent";
import { HttpFetcher, PrusaLinkCommandDispatcher } from "../obico/types";

const httpFetcher: HttpFetcher = { fetch: (u, o) => fetch(u, o) };
const noopDispatcher: PrusaLinkCommandDispatcher = {
  pause: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
  startPrint: () => Promise.resolve(),
  uploadFile: () => Promise.resolve(),
};

const router = Router();

router.post("/test-prusalink", async (req, res) => {
  const body = req.body as {
    url?: string;
    username?: string;
    password?: string;
  };
  let password: string | undefined;
  try {
    password = mergeStoredSecrets({ prusalink: body }, tryLoadConfig())
      .prusalink?.password;
  } catch (err) {
    if (err instanceof SecretFallbackError) {
      res.status(400).json({ message: err.message });
      return;
    }
    throw err;
  }
  const { url, username } = body;

  if (!url || !username || !password) {
    res
      .status(400)
      .json({ message: "url, username and password are required" });
    return;
  }

  const client = createPrusaLinkClient({ baseUrl: url, username, password });
  const result = await client.testConnection();

  if (result.ok) {
    res.json({ ok: true });
  } else {
    res.status(502).json({ message: result.error ?? "Connection failed" });
  }
});

router.post("/test-camera", async (req, res) => {
  const { rtspUrl } = req.body as { rtspUrl?: string };

  if (!rtspUrl) {
    res.status(400).json({ message: "rtspUrl is required" });
    return;
  }

  const camera = createCamera({ rtspUrl, frameIntervalSeconds: 10 });
  try {
    const frame = await camera.testStream();
    res.json({ ok: true, frame: frame.toString("base64") });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream not reachable";
    res.status(502).json({ message });
  }
});

// Pairs with Obico and saves the whole setup with the new API key, so the key
// never reaches the browser (nor the Obico http tunnel, which can call /api/).
router.post("/verify-pairing", async (req, res) => {
  const { obicoServerUrl, code, ...setup } = req.body as Partial<Config> & {
    obicoServerUrl?: string;
    code?: string;
  };

  if (!obicoServerUrl || !code) {
    res.status(400).json({ message: "obicoServerUrl and code are required" });
    return;
  }

  // Validate the rest of the setup before pairing; the placeholder key is
  // replaced by the paired one below.
  const placeholder = "pending-pairing";
  let config: Config;
  try {
    config = resolveSetup({
      ...setup,
      obico: { serverUrl: obicoServerUrl, apiKey: placeholder },
    });
  } catch (err) {
    if (err instanceof SetupError || err instanceof SecretFallbackError) {
      res.status(400).json({ message: err.message });
      return;
    }
    throw err;
  }

  const agent = createObicoAgent(
    { serverUrl: obicoServerUrl, apiKey: "" },
    httpFetcher,
    noopDispatcher
  );

  try {
    const apiKey = await agent.waitForPairing(obicoServerUrl, code);
    saveSetup({ ...config, obico: { serverUrl: obicoServerUrl, apiKey } });
    res.json({ ok: true, serverUrl: obicoServerUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pairing failed";
    if (/timed out/i.test(message)) {
      res.status(504).json({ message });
    } else if (/expired/i.test(message)) {
      res.status(410).json({ message });
    } else {
      res.status(502).json({ message });
    }
  }
});

router.get("/configured", (_req, res) => {
  res.json({ configured: isConfigured() });
});

export { router as wizardRouter };
