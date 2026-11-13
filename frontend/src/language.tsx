import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import en from './locales/en.json';
import vi from './locales/vi.json';

export type TranslationKey = keyof typeof en;
type Language = 'en' | 'vi';
const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, vi };
const storageKey = 'opnsense_noc_lang';
const sampleNames: Record<string, string> = {
  wan: 'Example ISP', firewall: 'OPNsense', core: 'SW-CORE', server: 'Proxmox',
  home: 'Home Assistant', nas: 'Synology NAS', frigate: 'Frigate NVR', cisco: 'CISCO_SW#3',
  sw1: 'Switch1-251', sw2: 'Switch2-252', cloud: 'UniFi Cloud Key', office: 'AP_Office',
  lobby: 'AP_Lobby', warehouse: 'AP_Warehouse', cam1: 'Camera Entrance',
  cam2: 'Camera Parking', cam3: 'Camera Warehouse',
};

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'en' || saved === 'vi') return saved;
  } catch {
    // Storage may be unavailable in private or restricted contexts.
  }
  return /^vi(?:-|$)/i.test(navigator.language) ? 'vi' : 'en';
}

type LanguageState = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
  deviceName: (device: { id: string; name: string }, mock?: boolean) => string;
};
const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    try { localStorage.setItem(storageKey, language); } catch { /* Keep the in-memory preference. */ }
  }, [language]);

  const value = useMemo<LanguageState>(() => {
    const t = (key: TranslationKey) => dictionaries[language][key];
    return {
      language, setLanguage, t,
      deviceName: (device, mock) => mock && Object.hasOwn(sampleNames, device.id) &&
        sampleNames[device.id] === device.name ? t(('sample_' + device.id) as TranslationKey) : device.name,
    };
  }, [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const state = useContext(LanguageContext);
  if (!state) throw new Error('LanguageProvider is required');
  return state;
}

export function apiErrorKey(status: number, fallback: TranslationKey): TranslationKey {
  const keys: Partial<Record<number, TranslationKey>> = {
    400: 'invalidConfig', 401: 'authRequired', 403: 'readOnly', 409: 'conflict',
    422: 'snmpDisabled', 429: 'rateLimited',
  };
  return keys[status] ?? fallback;
}

export function LanguageSwitch() {
  const { language, setLanguage, t } = useLanguage();
  return <div className="language-switch" role="group" aria-label={t('language')}>
    <button type="button" lang="vi" aria-pressed={language === 'vi'} onClick={() => setLanguage('vi')}>VI</button>
    <span aria-hidden="true">|</span>
    <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
  </div>;
}
