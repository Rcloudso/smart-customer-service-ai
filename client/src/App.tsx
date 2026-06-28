import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Loading } from 'tdesign-react';
import { useTranslation } from './hooks/usePreferences';

const ChatPage = lazy(() => import('./pages/ChatPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const DashboardPage = lazy(() => import('./pages/admin/DashboardPage'));
const ConversationsPage = lazy(() => import('./pages/admin/ConversationsPage'));
const FaqManagementPage = lazy(() => import('./pages/admin/FaqManagementPage'));
const ModelConfigPage = lazy(() => import('./pages/admin/ModelConfigPage'));
const AuthGuard = lazy(() => import('./components/common/AuthGuard'));

function PageFallback(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Loading text={t('app.loading')} />
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/admin"
            element={
              <AuthGuard>
                <AdminLayout />
              </AuthGuard>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="conversations" element={<ConversationsPage />} />
            <Route path="faq" element={<FaqManagementPage />} />
            <Route path="config" element={<ModelConfigPage />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
