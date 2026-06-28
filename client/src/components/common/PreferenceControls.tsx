import React from 'react';
import { Button, Space, Tooltip } from 'tdesign-react';
import { ModeDarkIcon, ModeLightIcon, TranslateIcon } from 'tdesign-icons-react';
import { LANGUAGE_LABELS } from '../../i18n';
import { usePreferences, useTranslation } from '../../hooks/usePreferences';

interface PreferenceControlsProps {
  compact?: boolean;
}

export function PreferenceControls({ compact = false }: PreferenceControlsProps): React.ReactElement {
  const language = usePreferences((state) => state.language);
  const theme = usePreferences((state) => state.theme);
  const toggleLanguage = usePreferences((state) => state.toggleLanguage);
  const toggleTheme = usePreferences((state) => state.toggleTheme);
  const { t } = useTranslation();

  return (
    <Space size="small">
      <Tooltip content={language === 'zh' ? t('preferences.switchToEnglish') : t('preferences.switchToChinese')}>
        <Button
          variant="outline"
          size="small"
          icon={<TranslateIcon />}
          onClick={toggleLanguage}
          aria-label={t('preferences.language')}
        >
          {compact ? (language === 'zh' ? '中' : 'EN') : LANGUAGE_LABELS[language]}
        </Button>
      </Tooltip>
      <Tooltip content={theme === 'light' ? t('preferences.switchToDark') : t('preferences.switchToLight')}>
        <Button
          variant="outline"
          size="small"
          icon={theme === 'light' ? <ModeDarkIcon /> : <ModeLightIcon />}
          onClick={toggleTheme}
          aria-label={t('preferences.theme')}
        >
          {compact ? '' : theme === 'light' ? t('preferences.light') : t('preferences.dark')}
        </Button>
      </Tooltip>
    </Space>
  );
}

export default PreferenceControls;
