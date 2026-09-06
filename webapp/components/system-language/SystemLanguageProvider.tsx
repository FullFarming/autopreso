"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatSystemText, isSystemLanguage, normalizeSystemLanguage, readStoredSystemLanguage, SYSTEM_LANGUAGE_STORAGE_KEY, type SystemLanguage, type SystemMessages, type SystemTextValues } from "../../lib/system-language";

interface SystemLanguageContextValue {
  language: SystemLanguage;
  setLanguage: (language: SystemLanguage) => void;
  hasStorageError: boolean;
}

const SystemLanguageContext = createContext<SystemLanguageContextValue>({ language: "ko", setLanguage: () => undefined, hasStorageError: false });

function writeLanguageCookie(language: SystemLanguage) {
  document.cookie = `${SYSTEM_LANGUAGE_STORAGE_KEY}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

export function SystemLanguageProvider({ children, initialLanguage = "ko" }: { children: ReactNode; initialLanguage?: SystemLanguage }) {
  const [language, updateLanguage] = useState<SystemLanguage>(() => normalizeSystemLanguage(initialLanguage));
  const [hasStorageError, setHasStorageError] = useState(false);

  const setLanguage = useCallback((next: SystemLanguage) => {
    if (!isSystemLanguage(next)) return;
    updateLanguage(next);
    document.documentElement.lang = next;
    try {
      localStorage.setItem(SYSTEM_LANGUAGE_STORAGE_KEY, next);
      writeLanguageCookie(next);
      setHasStorageError(false);
    } catch {
      setHasStorageError(true);
    }
  }, []);

  useEffect(() => {
    try {
      const stored = readStoredSystemLanguage(localStorage, normalizeSystemLanguage(initialLanguage));
      updateLanguage(stored);
      document.documentElement.lang = stored;
      writeLanguageCookie(stored);
    } catch {
      setHasStorageError(true);
    }
    function receiveStoredLanguage(event: StorageEvent) {
      if (event.key !== null && event.key !== SYSTEM_LANGUAGE_STORAGE_KEY) return;
      try {
        if (event.storageArea !== localStorage) return;
        // 2026-08-31 fix: A queued event may predate a newer local choice; storage is the current authority.
        const stored = localStorage.getItem(SYSTEM_LANGUAGE_STORAGE_KEY);
        if (stored !== null && !isSystemLanguage(stored)) return;
        // 2026-08-31 fix: Clearing preferences in another tab restores the default, including its SSR cookie.
        const next = normalizeSystemLanguage(stored);
        updateLanguage(next);
        document.documentElement.lang = next;
        writeLanguageCookie(next);
        setHasStorageError(false);
      } catch {
        setHasStorageError(true);
      }
    }
    window.addEventListener("storage", receiveStoredLanguage);
    return () => window.removeEventListener("storage", receiveStoredLanguage);
  }, [initialLanguage]);

  const value = useMemo(() => ({ language, setLanguage, hasStorageError }), [language, setLanguage, hasStorageError]);
  return <SystemLanguageContext.Provider value={value}>{children}</SystemLanguageContext.Provider>;
}

export function useSystemLanguage() {
  return useContext(SystemLanguageContext);
}

export function useSystemText(messages: SystemMessages): (key: string, values?: SystemTextValues) => string {
  const { language } = useSystemLanguage();
  const current = useRef({ language, messages });
  current.current = { language, messages };
  // 2026-08-31 fix: Translating interface copy must not reconnect effects that depend on t.
  return useCallback((key: string, values?: SystemTextValues) => formatSystemText(current.current.messages, current.current.language, key, values), []);
}
