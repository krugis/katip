// SPDX-License-Identifier: AGPL-3.0-only
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import tr from './locales/tr.json';

const STORAGE_KEY = 'katip.language';
export const LANGUAGES = ['tr', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

const stored = (): Language => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'tr';
  } catch {
    return 'tr';
  }
};

void i18n.use(initReactI18next).init({
  resources: { tr: { translation: tr }, en: { translation: en } },
  lng: stored(),
  fallbackLng: 'tr',
  interpolation: { escapeValue: false },
});

const applyToDocument = (language: string) => {
  document.documentElement.lang = language;
};
applyToDocument(i18n.language);
i18n.on('languageChanged', applyToDocument);

export function setLanguage(language: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Private browsing: it lasts for this page only.
  }
  void i18n.changeLanguage(language);
}

export default i18n;
