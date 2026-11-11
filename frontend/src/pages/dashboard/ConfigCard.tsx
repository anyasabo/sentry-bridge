import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Collapse,
  Group,
  NumberInput,
  Stack,
  TextInput,
  Title,
  Alert,
} from "@mantine/core";
import { IconCheck, IconSettings } from "@tabler/icons-react";
import { SecretInput } from "../../components/SecretInput";
import { useTranslation } from "react-i18next";

interface ConfigForm {
  name: string;
  prusaLinkUrl: string;
  username: string;
  password: string;
  passwordHint: string;
  rtspUrl: string;
  frameInterval: number;
  obicoServerUrl: string;
  bridgeUrl: string;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function ConfigCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ConfigForm>({
    name: "",
    prusaLinkUrl: "",
    username: "",
    password: "",
    passwordHint: "",
    rtspUrl: "",
    frameInterval: 10,
    obicoServerUrl: "",
    bridgeUrl: "",
  });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        setForm({
          name: cfg.name ?? "",
          prusaLinkUrl: cfg.prusalink?.url ?? "",
          username: cfg.prusalink?.username ?? "",
          password: "",
          passwordHint: cfg.prusalink?.passwordHint ?? "",
          rtspUrl: cfg.camera?.rtspUrl ?? "",
          frameInterval: cfg.camera?.frameIntervalSeconds ?? 10,
          obicoServerUrl: cfg.obico?.serverUrl ?? "",
          bridgeUrl: cfg.bridgeUrl ?? "",
        });
      })
      .catch(() => {});
  }, []);

  function patch(key: keyof ConfigForm, value: string | number) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaveStatus("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/setup/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name || undefined,
          prusalink: {
            url: form.prusaLinkUrl,
            username: form.username,
            password: form.password,
          },
          camera: {
            rtspUrl: form.rtspUrl,
            frameIntervalSeconds: form.frameInterval,
          },
          // Empty key keeps the stored one; the backend refuses this if the
          // server URL changed (that needs re-pairing in the wizard).
          obico: { serverUrl: form.obicoServerUrl, apiKey: "" },
          polling: { statusIntervalMs: 5000 },
          bridgeUrl: form.bridgeUrl || undefined,
        }),
      });
      if (res.ok) {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(body.message ?? t("dashboard.config.error"));
        setSaveStatus("error");
      }
    } catch {
      setErrorMsg(t("dashboard.config.error"));
      setSaveStatus("error");
    }
  }

  return (
    <Card withBorder radius="md" p="md">
      <Group
        justify="space-between"
        style={{ cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <Title order={5}>{t("dashboard.config.heading")}</Title>
        <IconSettings size={18} />
      </Group>
      <Collapse expanded={open}>
        <Stack gap="sm" mt="md">
          <TextInput
            label={t("dashboard.config.name")}
            value={form.name}
            onChange={(e) => patch("name", e.currentTarget.value)}
            placeholder={t("dashboard.config.name_placeholder")}
            description={t("dashboard.config.name_hint")}
          />
          <TextInput
            label={t("dashboard.config.prusalink_url")}
            value={form.prusaLinkUrl}
            onChange={(e) => patch("prusaLinkUrl", e.currentTarget.value)}
            placeholder="http://192.168.1.x"
          />
          <TextInput
            label={t("dashboard.config.username")}
            value={form.username}
            onChange={(e) => patch("username", e.currentTarget.value)}
          />
          <SecretInput
            label={t("dashboard.config.password")}
            value={form.password}
            onChange={(e) => patch("password", e.currentTarget.value)}
            hint={form.passwordHint}
          />
          <TextInput
            label={t("dashboard.config.rtsp_url")}
            value={form.rtspUrl}
            onChange={(e) => patch("rtspUrl", e.currentTarget.value)}
            placeholder="rtsp://192.168.1.x/live"
          />
          <NumberInput
            label={t("dashboard.config.frame_interval")}
            value={form.frameInterval}
            onChange={(v) => patch("frameInterval", Number(v))}
            min={1}
            max={60}
          />
          <TextInput
            label={t("dashboard.config.obico_url")}
            value={form.obicoServerUrl}
            onChange={(e) => patch("obicoServerUrl", e.currentTarget.value)}
            placeholder="http://192.168.1.x:3334"
          />
          <TextInput
            label={t("dashboard.config.bridge_url")}
            value={form.bridgeUrl}
            onChange={(e) => patch("bridgeUrl", e.currentTarget.value)}
            placeholder="http://192.168.1.x:3000 (leer = auto)"
          />
          {saveStatus === "saved" && (
            <Alert color="green" icon={<IconCheck size={16} />}>
              {t("dashboard.config.saved")}
            </Alert>
          )}
          {saveStatus === "error" && <Alert color="red">{errorMsg}</Alert>}
          <Button loading={saveStatus === "saving"} onClick={handleSave}>
            {t("dashboard.config.save")}
          </Button>
        </Stack>
      </Collapse>
    </Card>
  );
}
