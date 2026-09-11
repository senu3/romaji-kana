import { useCallback, useEffect, useRef, useState } from "react";

const SETUP_COMPLETE_STORAGE_KEY = "romaji-kana-setup-complete";

const FORCE_SETUP_QUERY_PARAM = "setup";

const ENABLE_FIRST_RUN_SETUP_MODAL = false;

function shouldForceSetupModalFromQuery(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const value = new URLSearchParams(window.location.search).get(FORCE_SETUP_QUERY_PARAM);
  return value === "1" || value === "true";
}

function shouldShowSetupModalOnStartup(): boolean {
  if (shouldForceSetupModalFromQuery()) {
    return true;
  }

  if (!ENABLE_FIRST_RUN_SETUP_MODAL) {
    return false;
  }

  return localStorage.getItem(SETUP_COMPLETE_STORAGE_KEY) !== "true";
}

export function useModelSetup() {
  const [setupComplete, setSetupComplete] = useState(() => {
    if (typeof localStorage === "undefined") {
      return true;
    }
    return !shouldShowSetupModalOnStartup();
  });

  const setupCompleteRef = useRef(setupComplete);

  useEffect(() => {
    setupCompleteRef.current = setupComplete;
  }, [setupComplete]);

  const completeSetup = useCallback(() => {
    setSetupComplete(true);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SETUP_COMPLETE_STORAGE_KEY, "true");
    }
  }, []);

  return { setupComplete, setupCompleteRef, completeSetup };
}
