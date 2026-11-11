import { useEffect, useState } from "react";
import { Container, Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { usePrinterStatus } from "./usePrinterStatus";
import { HealthCard } from "./HealthCard";
import { BootChecksCard } from "./BootChecksCard";
import { PrinterCard } from "./PrinterCard";
import { CameraCard } from "./CameraCard";
import { ConfigCard } from "./ConfigCard";
import { FileBrowserCard } from "./FileBrowserCard";

export function DashboardPage() {
  const { t } = useTranslation();
  const { status } = usePrinterStatus();
  const [printerName, setPrinterName] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/printer/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.name && setPrinterName(d.name))
      .catch(() => {});
  }, []);

  return (
    <Container size="lg" py="xl">
      <Title order={2} mb="xl" ta="center">
        {printerName ?? t("dashboard.title")}
      </Title>
      <Stack gap="md">
        <BootChecksCard />
        <HealthCard />
        <PrinterCard status={status} />
        <CameraCard />
        <FileBrowserCard status={status} />
        <ConfigCard />
      </Stack>
    </Container>
  );
}
