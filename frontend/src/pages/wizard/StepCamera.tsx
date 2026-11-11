import { useState, useEffect } from "react";
import {
  Button,
  Stack,
  Text,
  TextInput,
  Alert,
  Image,
  Skeleton,
} from "@mantine/core";
import {
  IconCamera,
  IconCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useWizard } from "./WizardContext";

type Status = "idle" | "testing" | "ok" | "error";

export function StepCamera() {
  const { t } = useTranslation();
  const { data, setData, nextStep, prevStep } = useWizard();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Auto-test when pre-filled from existing config
  useEffect(() => {
    if (data.rtspUrl) {
      handleTest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTest() {
    setStatus("testing");
    setPreviewUrl(null);
    setErrorMsg("");
    try {
      const res = await fetch("/api/wizard/test-camera", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtspUrl: data.rtspUrl }),
      });
      if (res.ok) {
        const body = await res.json();
        setPreviewUrl(
          body.frame ? `data:image/jpeg;base64,${body.frame}` : null
        );
        setStatus("ok");
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(body.message ?? t("wizard.camera.error"));
        setStatus("error");
      }
    } catch {
      setErrorMsg(t("wizard.camera.error"));
      setStatus("error");
    }
  }

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {t("wizard.camera.description")}
      </Text>
      <TextInput
        label={t("wizard.camera.rtsp_url")}
        placeholder={t("wizard.camera.rtsp_placeholder")}
        value={data.rtspUrl}
        onChange={(e) => setData({ rtspUrl: e.currentTarget.value })}
      />
      {status === "ok" && (
        <Alert color="green" icon={<IconCheck size={16} />}>
          {t("wizard.camera.success")}
        </Alert>
      )}
      {status === "error" && (
        <Alert color="red" icon={<IconX size={16} />}>
          <Text size="sm">{errorMsg}</Text>
        </Alert>
      )}
      {/* Emphasised when the test failed, a dimmed tip otherwise. */}
      <Text
        size={status === "error" ? "sm" : "xs"}
        fw={status === "error" ? 600 : undefined}
        c={status === "error" ? undefined : "dimmed"}
      >
        <IconInfoCircle size={12} style={{ verticalAlign: "middle" }} />{" "}
        {t("wizard.camera.rtsp_hint")}
      </Text>
      {status === "testing" && <Skeleton height={180} radius="md" />}
      {previewUrl && (
        <Image src={previewUrl} alt={t("wizard.camera.preview")} radius="md" />
      )}
      <Button
        leftSection={<IconCamera size={16} />}
        variant="default"
        loading={status === "testing"}
        onClick={handleTest}
        disabled={!data.rtspUrl}
      >
        {t("wizard.camera.test")}
      </Button>
      <Button.Group>
        <Button variant="default" onClick={prevStep} style={{ flex: 1 }}>
          {t("wizard.camera.back")}
        </Button>
        <Button
          onClick={nextStep}
          disabled={status !== "ok"}
          style={{ flex: 1 }}
        >
          {t("wizard.camera.next")}
        </Button>
      </Button.Group>
    </Stack>
  );
}
