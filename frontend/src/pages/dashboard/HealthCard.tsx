import {
  Accordion,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconRefresh,
  IconShield,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  useHealth,
  type HealthState,
  type ComponentStats,
  type ReconnectTarget,
} from "../../hooks/useHealth";
import classes from "./HealthCard.module.css";

// ---------- Shared helpers ----------

type CBState = "CLOSED" | "OPEN" | "HALF_OPEN";
type ErrorSeverity = "warn" | "error" | "critical";

function stateColor(state: HealthState): string {
  switch (state) {
    case "healthy":
      return "green";
    case "degraded":
      return "yellow";
    case "recovering":
      return "orange";
    case "down":
      return "red";
  }
}

function severityColor(severity: ErrorSeverity): string {
  switch (severity) {
    case "warn":
      return "yellow";
    case "error":
    case "critical":
      return "red";
  }
}

function cbStateColor(state: CBState): string {
  switch (state) {
    case "CLOSED":
      return "green";
    case "HALF_OPEN":
      return "yellow";
    case "OPEN":
      return "red";
  }
}

function formatDuration(sinceMs: number): string {
  const s = Math.floor((Date.now() - sinceMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function StateIcon({ state }: { state: HealthState }) {
  const color = stateColor(state);
  switch (state) {
    case "healthy":
      return (
        <ThemeIcon color={color} variant="light" size="sm">
          <IconCircleCheck size={14} />
        </ThemeIcon>
      );
    case "recovering":
      return (
        <ThemeIcon color={color} variant="light" size="sm">
          <IconRefresh size={14} />
        </ThemeIcon>
      );
    case "degraded":
      return (
        <ThemeIcon color={color} variant="light" size="sm">
          <IconAlertTriangle size={14} />
        </ThemeIcon>
      );
    case "down":
      return (
        <ThemeIcon color={color} variant="light" size="sm">
          <IconCircleX size={14} />
        </ThemeIcon>
      );
  }
}

// ComponentRow — advanced view for the Accordion panel
const COMPONENT_LABELS: Record<string, string> = {
  prusalink: "PrusaLink",
  camera: "Kamera",
  obico_ws: "Obico WS",
  janus: "Janus",
  rtp_stream: "RTP Stream",
  janus_relay: "Janus Relay",
};

function ComponentRow({
  name,
  stats,
}: {
  name: string;
  stats: ComponentStats;
}) {
  const label = COMPONENT_LABELS[name] ?? name;
  const hasDetails = stats.lastErrors.length > 0 || !!stats.circuitBreaker;

  return (
    <Stack gap={6}>
      <Group justify="space-between">
        <Group gap="xs">
          <StateIcon state={stats.state} />
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {stats.restartCount > 0 && (
            <Tooltip label={`${stats.restartCount} Neustart(s) seit Start`}>
              <Badge
                size="xs"
                color={stats.restartCount >= 3 ? "orange" : "gray"}
                variant="light"
              >
                ↺ {stats.restartCount}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {formatDuration(stats.stateSince)}
          </Text>
          <Badge size="xs" color={stateColor(stats.state)} variant="light">
            {stats.state.toUpperCase()}
          </Badge>
        </Group>
      </Group>

      {hasDetails && (
        <Stack gap={4} pl="calc(1.5rem + 8px)">
          {stats.circuitBreaker && (
            <Group gap="xs" wrap="nowrap">
              <ThemeIcon
                color={cbStateColor(stats.circuitBreaker.state)}
                variant="light"
                size="xs"
                style={{ flexShrink: 0 }}
              >
                <IconShield size={10} />
              </ThemeIcon>
              <Text size="xs" c="dimmed">
                CB:{" "}
                <Text
                  span
                  fw={600}
                  c={cbStateColor(stats.circuitBreaker.state)}
                >
                  {stats.circuitBreaker.state}
                </Text>
                {stats.circuitBreaker.state === "OPEN" &&
                  stats.circuitBreaker.timeUntilHalfOpenMs !== null && (
                    <>
                      {" "}
                      — Reset in{" "}
                      {Math.ceil(
                        stats.circuitBreaker.timeUntilHalfOpenMs / 1000
                      )}
                      s
                    </>
                  )}
                {" · "}
                {stats.circuitBreaker.failureCount}/
                {stats.circuitBreaker.totalFailures} Fehler
                {" · "}
                {stats.circuitBreaker.totalSuccesses} OK
              </Text>
            </Group>
          )}
          {stats.lastErrors.map((e, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
              <Badge
                size="xs"
                color={severityColor(e.severity)}
                variant="dot"
                style={{ flexShrink: 0, marginTop: 2 }}
              >
                {e.severity}
              </Badge>
              <Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                {new Date(e.ts).toLocaleTimeString()} — {e.msg}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

// ---------- Main 3-row layout ----------

const MAIN_ROWS: ReadonlyArray<{
  key: string;
  reconnectTarget: ReconnectTarget;
  labelKey: string;
}> = [
  {
    key: "prusalink",
    reconnectTarget: "prusalink",
    labelKey: "dashboard.status.prusalink",
  },
  {
    key: "obico_ws",
    reconnectTarget: "obico",
    labelKey: "dashboard.status.obico",
  },
  {
    key: "camera",
    reconnectTarget: "camera",
    labelKey: "dashboard.status.camera",
  },
];

const ADVANCED_ROWS = ["janus", "rtp_stream", "janus_relay"];

function statusLabelKey(state: HealthState): string {
  switch (state) {
    case "healthy":
      return "dashboard.health.status.connected";
    case "recovering":
      return "dashboard.health.status.connecting";
    case "degraded":
      return "dashboard.health.status.degraded";
    case "down":
      return "dashboard.health.status.disconnected";
  }
}

function HealthRow({
  labelKey,
  stats,
  reconnectTarget,
  isReconnecting,
  onReconnect,
}: {
  labelKey: string;
  stats: ComponentStats | undefined;
  reconnectTarget: ReconnectTarget;
  isReconnecting: boolean;
  onReconnect: (c: ReconnectTarget) => void;
}) {
  const { t } = useTranslation();
  if (!stats) return null;
  const isHealthy = stats.state === "healthy";
  return (
    <Group justify="space-between">
      <Group gap="xs">
        <StateIcon state={stats.state} />
        <Text size="sm">{t(labelKey)}</Text>
      </Group>
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          {t(statusLabelKey(stats.state))}
        </Text>
        {!isHealthy && (
          <Button
            variant="subtle"
            size="xs"
            loading={isReconnecting}
            leftSection={<IconRefresh size={12} />}
            onClick={() => onReconnect(reconnectTarget)}
          >
            {t("dashboard.health.reconnect")}
          </Button>
        )}
      </Group>
    </Group>
  );
}

export function HealthCard() {
  const { t } = useTranslation();
  const {
    health,
    isStale,
    secondsSinceLastFetch,
    fetchCount,
    reconnecting,
    reconnect,
  } = useHealth();

  const overall: HealthState = health?.overall ?? "recovering";
  const overallColor = stateColor(overall);

  const staleText =
    secondsSinceLastFetch >= 60
      ? t("dashboard.health.stale_minutes", {
          n: Math.floor(secondsSinceLastFetch / 60),
        })
      : t("dashboard.health.stale", { n: secondsSinceLastFetch });

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="xs">
        <Title order={5}>{t("dashboard.health.heading")}</Title>
        {health ? (
          isStale ? (
            <Badge
              color="gray"
              variant="outline"
              leftSection={<IconAlertTriangle size={12} />}
            >
              {staleText}
            </Badge>
          ) : (
            <Badge
              color={overallColor}
              variant="light"
              leftSection={
                // key restarts the pulse animation on every received response
                <span key={fetchCount} className={classes.dot} aria-hidden />
              }
            >
              {t(`dashboard.health.overall.${overall}`)}
            </Badge>
          )
        ) : (
          <Text size="xs" c="dimmed">
            {t("dashboard.health.loading")}
          </Text>
        )}
      </Group>

      <Stack gap="xs" style={{ opacity: isStale ? 0.5 : 1 }}>
        {MAIN_ROWS.map((row) => (
          <HealthRow
            key={row.key}
            labelKey={row.labelKey}
            stats={health?.components[row.key]}
            reconnectTarget={row.reconnectTarget}
            isReconnecting={!!reconnecting[row.reconnectTarget]}
            onReconnect={reconnect}
          />
        ))}
        {!health && (
          <Text size="sm" c="dimmed">
            {t("dashboard.health.loading")}
          </Text>
        )}
      </Stack>

      <Accordion variant="default" mt="xs">
        <Accordion.Item value="advanced">
          <Accordion.Control>
            {t("dashboard.health.advanced_details")}
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              {ADVANCED_ROWS.map((name) => {
                const stats = health?.components[name];
                if (!stats) return null;
                return <ComponentRow key={name} name={name} stats={stats} />;
              })}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Card>
  );
}
