import dictionary from './i18n/dictionary.json';

export type Language = 'zh' | 'en';

type DictionaryEntry = Record<Language, string>;

const DICTIONARY = dictionary as Record<string, DictionaryEntry>;

function readDictionaryValue(language: Language, key: string): string {
  return DICTIONARY[key]?.[language] ?? DICTIONARY[key]?.zh ?? key;
}

export function translate(
  language: Language,
  key: string,
  params?: Record<string, string | number>,
): string {
  let value = readDictionaryValue(language, key);
  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      value = value.replaceAll(`{${paramKey}}`, String(paramValue));
    }
  }
  return value;
}

export function intentLabel(language: Language, intent: string): string {
  return translate(language, `intent.${intent}`);
}

export function getDictionaryKeys(): string[] {
  return Object.keys(DICTIONARY);
}
