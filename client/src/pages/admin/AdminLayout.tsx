import React from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Dropdown } from 'tdesign-react';
import {
  DashboardIcon,
  ChatIcon,
  HelpCircleIcon,
  LogoutIcon,
  UserIcon,
  SettingIcon,
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
  { path: '/admin/conversations', labelKey: 'nav.conversations', icon: <ChatIcon /> },
  { path: '/admin/faq', labelKey: 'nav.faq', icon: <HelpCircleIcon /> },
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

  const handleMenuClick = (value: string | number) => {
    navigate(String(value));
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  // Determine active menu item based on current path
  const activePath = (() => {
    if (location.pathname === '/admin') return '/admin';
    if (location.pathname.startsWith('/admin/conversations')) return '/admin/conversations';
    if (location.pathname.startsWith('/admin/faq')) return '/admin/faq';
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

        {/* Main content */}
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

export default AdminLayout;
