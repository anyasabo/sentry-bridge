import { createContext, useContext, useEffect, useState } from "react";

export interface WizardData {
  printerIp: string;
  rtspUrl: string;
  username: string;
  password: string;
  /** Masked hint of the stored password; an empty password means "keep it". */
  passwordHint: string;
  obicoServerUrl: string;
  /** Masked hint of the stored API key; set when the printer is already paired. */
  obicoApiKeyHint: string;
}

interface WizardContextValue {
  data: WizardData;
  setData: (patch: Partial<WizardData>) => void;
  step: number;
  nextStep: () => void;
  prevStep: () => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);

const EMPTY: WizardData = {
  printerIp: "",
  rtspUrl: "",
  username: "maker",
  password: "",
  passwordHint: "",
  obicoServerUrl: "",
  obicoApiKeyHint: "",
};

export function WizardProvider({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState(0);
  const [data, setDataState] = useState<WizardData>(EMPTY);

  // Pre-fill from existing config if available
  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        setDataState({
          printerIp: cfg.prusalink?.url?.replace(/^https?:\/\//, "") ?? "",
          rtspUrl: cfg.camera?.rtspUrl ?? "",
          username: cfg.prusalink?.username ?? "maker",
          password: "",
          passwordHint: cfg.prusalink?.passwordHint ?? "",
          obicoServerUrl: cfg.obico?.serverUrl ?? "",
          obicoApiKeyHint: cfg.obico?.apiKeyHint ?? "",
        });
      })
      .catch(() => {});
  }, []);

  function setData(patch: Partial<WizardData>) {
    setDataState((prev) => ({ ...prev, ...patch }));
  }

  return (
    <WizardContext.Provider
      value={{
        data,
        setData,
        step,
        nextStep: () => setStep((s) => s + 1),
        prevStep: () => setStep((s) => s - 1),
      }}
    >
      {children}
    </WizardContext.Provider>
  );
}

export function useWizard() {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error("useWizard must be used inside WizardProvider");
  return ctx;
}
