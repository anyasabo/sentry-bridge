import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Group,
  List,
  Loader,
  Paper,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconRefresh,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

// Mirrors src/boot/checks.ts (the frontend has no shared-types package).
type BootCheckId =
  | "prusalink_reachable"
  | "prusalink_auth"
  | "camera_rtsp"
  | "obico_reachable"
  | "obico_paired";

type BootCheckHint =
  | "prusalinkUnreachable"
  | "prusalinkCredentials"
  | "cameraUnreachable"
  | "obicoUnreachable"
  | "obicoNotPaired";

interface BootCheckResult {
  id: BootCheckId;
  ok: boolean;
  hint: BootCheckHint | null;
}

interface BootCheckReport {
  checkedAt: string | null;
  results: BootCheckResult[];
}

// The bridge runs its checks in the background right after start, so the
// first GET may arrive before they finish. Failed GETs back off up to the max.
const PENDING_POLL_MS = 3_000;
const MAX_POLL_MS = 60_000;
// While a check fails, re-run them so the alert clears once the fault is fixed.
const FAILING_RECHECK_MS = 30_000;

async function fetchReport(
  method: "GET" | "POST",
  signal: AbortSignal
): Promise<BootCheckReport | null> {
  try {
    const res = await fetch("/api/boot-checks", { method, signal });
    return res.ok ? ((await res.json()) as BootCheckReport) : null;
  } catch {
    // Best effort; the health card covers connectivity.
    return null;
  }
}

/** Startup diagnostics (#13): one line when all pass, an alert on failure. */
export function BootChecksCard() {
  const { t } = useTranslation();
  const [report, setReport] = useState<BootCheckReport | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const controller = useRef(new AbortController());

  useEffect(() => {
    const ctrl = new AbortController();
    controller.current = ctrl;
    return () => ctrl.abort();
  }, []);

  const load = useCallback(async (method: "GET" | "POST") => {
    const signal = controller.current.signal;
    const next = await fetchReport(method, signal);
    if (next && !signal.aborted) setReport(next);
    return next;
  }, []);

  // Poll until the first run has finished.
  const pending = !report || report.checkedAt === null;
  useEffect(() => {
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout>;
    let delay = PENDING_POLL_MS;
    let stopped = false;
    const poll = async () => {
      const next = await load("GET");
      if (stopped || next?.checkedAt) return;
      delay = next ? PENDING_POLL_MS : Math.min(delay * 2, MAX_POLL_MS);
      timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, load]);

  const failing = !!report?.results.some((r) => !r.ok);
  useEffect(() => {
    if (!failing) return;
    const timer = setInterval(() => void load("POST"), FAILING_RECHECK_MS);
    return () => clearInterval(timer);
  }, [failing, load]);

  const recheck = async () => {
    setRechecking(true);
    await load("POST");
    if (!controller.current.signal.aborted) setRechecking(false);
  };

  const recheckButton = (
    <Button
      size="xs"
      variant="subtle"
      leftSection={<IconRefresh size={14} />}
      loading={rechecking}
      onClick={recheck}
    >
      {t("bootChecks.recheck")}
    </Button>
  );

  if (!failing) {
    const running = pending || rechecking;
    return (
      <Paper withBorder radius="md" px="md" py="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            {running ? (
              <Loader size={16} />
            ) : (
              <ThemeIcon color="green" size="sm" radius="xl">
                <IconCircleCheck size={14} />
              </ThemeIcon>
            )}
            <Text size="sm">
              {running ? t("bootChecks.running") : t("bootChecks.allPassed")}
            </Text>
          </Group>
          {recheckButton}
        </Group>
      </Paper>
    );
  }

  return (
    <Alert
      color="red"
      variant="light"
      icon={<IconAlertTriangle />}
      title={t("bootChecks.title")}
    >
      <List spacing="xs" size="sm" center>
        {report!.results.map((r) => (
          <List.Item
            key={r.id}
            icon={
              <ThemeIcon color={r.ok ? "green" : "red"} size="sm" radius="xl">
                {r.ok ? (
                  <IconCircleCheck size={14} />
                ) : (
                  <IconCircleX size={14} />
                )}
              </ThemeIcon>
            }
          >
            <Text size="sm" fw={500}>
              {t(`bootChecks.checks.${r.id}`)}
            </Text>
            {r.hint && (
              <Text size="xs" c="dimmed">
                {t(`bootChecks.hints.${r.hint}`)}
              </Text>
            )}
          </List.Item>
        ))}
      </List>
      <Group mt="sm">{recheckButton}</Group>
    </Alert>
  );
}
