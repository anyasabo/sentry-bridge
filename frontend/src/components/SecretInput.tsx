import { PasswordInput, PasswordInputProps } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface SecretInputProps extends PasswordInputProps {
  /** Masked hint of the stored secret; when set, an empty field keeps it. */
  hint: string;
}

export function SecretInput({ hint, ...props }: SecretInputProps) {
  const { t } = useTranslation();
  return (
    <PasswordInput
      {...props}
      placeholder={hint || undefined}
      description={hint ? t("common.secret_keep_hint") : undefined}
    />
  );
}
