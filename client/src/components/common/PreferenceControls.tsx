import React from 'react';
import { Button, Space, Tooltip } from 'tdesign-react';
import { ModeDarkIcon, ModeLightIcon, TranslateIcon } from 'tdesign-icons-react';
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
          data-testid="language-toggle"
        >
          {compact ? t('preferences.currentLanguageShort') : t('preferences.currentLanguageLabel')}
        </Button>
      </Tooltip>
      <Tooltip content={theme === 'light' ? t('preferences.switchToDark') : t('preferences.switchToLight')}>
        <Button
          variant="outline"
          size="small"
          icon={theme === 'light' ? <ModeDarkIcon /> : <ModeLightIcon />}
          onClick={toggleTheme}
          aria-label={t('preferences.theme')}
          data-testid="theme-toggle"
        >
          {compact ? '' : theme === 'light' ? t('preferences.light') : t('preferences.dark')}
        </Button>
      </Tooltip>
    </Space>
  );
}

export default PreferenceControls;
