import React, { useEffect, useState } from 'react';
import { Loading } from 'tdesign-react';
import { Navigate } from 'react-router-dom';
import { getOnboarding } from '../../api/admin';
import { useTranslation } from '../../hooks/usePreferences';
import DashboardPage from './DashboardPage';

export default function AdminIndexRoute(): React.ReactElement {
  const { t } = useTranslation();
  const [redirect, setRedirect] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void getOnboarding()
      .then((state) => { if (active) setRedirect(state.shouldAutoRedirect); })
      .catch(() => { if (active) setRedirect(false); });
    return () => { active = false; };
  }, []);

  if (redirect === null) {
    return <div className="app-centered-state"><Loading text={t('common.loading')} /></div>;
  }
  if (redirect) return <Navigate to="/admin/getting-started" replace />;
  return <DashboardPage />;
}
