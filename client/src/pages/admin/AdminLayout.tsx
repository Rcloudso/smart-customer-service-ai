import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Drawer, Dropdown } from 'tdesign-react';
import {
  DashboardIcon,
  ChatIcon,
  HelpCircleIcon,
  LogoutIcon,
  UserIcon,
  SettingIcon,
  FileSearchIcon,
  FileIconIcon,
  SearchIcon,
  QueueIcon,
  ServerIcon,
  CheckCircleIcon,
  MenuFoldIcon,
} from 'tdesign-icons-react';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../hooks/usePreferences';
import { PreferenceControls } from '../../components/common/PreferenceControls';

const { Header, Aside, Content } = Layout;

interface MenuItem {
  path: string;
  labelKey: string;
  icon: React.ReactElement;
}

const MENU_ITEMS: MenuItem[] = [
  { path: '/admin', labelKey: 'nav.dashboard', icon: <DashboardIcon /> },
  { path: '/admin/getting-started', labelKey: 'nav.gettingStarted', icon: <CheckCircleIcon /> },
  { path: '/admin/operations', labelKey: 'nav.operations', icon: <ServerIcon /> },
  { path: '/admin/conversations', labelKey: 'nav.conversations', icon: <ChatIcon /> },
  { path: '/admin/escalations', labelKey: 'nav.escalations', icon: <QueueIcon /> },
  { path: '/admin/faq', labelKey: 'nav.faq', icon: <HelpCircleIcon /> },
  { path: '/admin/documents', labelKey: 'nav.documents', icon: <FileIconIcon /> },
  { path: '/admin/knowledge-review', labelKey: 'nav.knowledgeReview', icon: <FileSearchIcon /> },
  { path: '/admin/quality-lab', labelKey: 'nav.qualityLab', icon: <SearchIcon /> },
  { path: '/admin/retrieval-ops', labelKey: 'nav.retrievalOps', icon: <ServerIcon /> },
  { path: '/admin/config', labelKey: 'nav.config', icon: <SettingIcon /> },
];

/**
 * Admin layout with sidebar navigation, header, and content area.
 */
export function AdminLayout(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const [mobileNavVisible, setMobileNavVisible] = useState(false);

  const handleMenuClick = (value: string | number) => {
    navigate(String(value));
    setMobileNavVisible(false);
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  // Determine active menu item based on current path
  const activePath = (() => {
    if (location.pathname === '/admin') return '/admin';
    if (location.pathname.startsWith('/admin/getting-started')) return '/admin/getting-started';
    if (location.pathname.startsWith('/admin/operations')) return '/admin/operations';
    if (location.pathname.startsWith('/admin/conversations')) return '/admin/conversations';
    if (location.pathname.startsWith('/admin/escalations')) return '/admin/escalations';
    if (location.pathname.startsWith('/admin/faq')) return '/admin/faq';
    if (location.pathname.startsWith('/admin/documents')) return '/admin/documents';
    if (location.pathname.startsWith('/admin/knowledge-review')) return '/admin/knowledge-review';
    if (location.pathname.startsWith('/admin/quality-lab')) return '/admin/quality-lab';
    if (location.pathname.startsWith('/admin/retrieval-ops')) return '/admin/retrieval-ops';
    if (location.pathname.startsWith('/admin/config')) return '/admin/config';
    return '/admin';
  })();

  const dropdownOptions = [
    {
      content: t('admin.logout'),
      value: 'logout',
      prefixIcon: <LogoutIcon />,
    },
  ];

  return (
    <Layout className="app-admin-layout">
      {/* Sidebar */}
      <Aside className="app-admin-sidebar">
        {/* Logo area */}
        <div className="app-admin-brand">
          <div>
            <h1 className="app-admin-brand-title">{t('admin.title')}</h1>
            <div className="app-admin-brand-subtitle">Customer Ops</div>
          </div>
        </div>

        <Menu
          value={activePath}
          onChange={handleMenuClick}
          style={{ border: 'none', paddingTop: '8px' }}
        >
          {MENU_ITEMS.map((item) => (
            <Menu.MenuItem key={item.path} value={item.path} icon={item.icon}>
              {t(item.labelKey)}
            </Menu.MenuItem>
          ))}
        </Menu>
      </Aside>

      <Layout>
        {/* Header */}
        <Header className="app-admin-header">
          <Button
            className="app-mobile-nav-trigger"
            variant="text"
            shape="square"
            size="large"
            icon={<MenuFoldIcon />}
            aria-label={t('admin.openNavigation')}
            onClick={() => setMobileNavVisible(true)}
          />
          <PreferenceControls />
          <Dropdown
            options={dropdownOptions}
            onClick={(data) => {
              if (data.value === 'logout') {
                handleLogout();
              }
            }}
          >
            <Button variant="text" icon={<UserIcon />}>
              {user?.username || t('admin.userFallback')}
            </Button>
          </Dropdown>
        </Header>

        <Drawer
          visible={mobileNavVisible}
          placement="left"
          size="min(320px, 88vw)"
          header={t('admin.navigation')}
          footer={false}
          closeOnEscKeydown
          closeOnOverlayClick
          onClose={() => setMobileNavVisible(false)}
          className="app-mobile-nav-drawer"
        >
          <Menu value={activePath} onChange={handleMenuClick}>
            {MENU_ITEMS.map((item) => (
              <Menu.MenuItem key={item.path} value={item.path} icon={item.icon}>
                {t(item.labelKey)}
              </Menu.MenuItem>
            ))}
          </Menu>
        </Drawer>

        {/* Main content */}
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

export default AdminLayout;
