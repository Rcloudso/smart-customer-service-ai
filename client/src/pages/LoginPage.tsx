import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, Card, MessagePlugin } from 'tdesign-react';
import { LockOnIcon, UserIcon } from 'tdesign-icons-react';
import { useAuth } from '../hooks/useAuth';
import { useTranslation } from '../hooks/usePreferences';
import { PreferenceControls } from '../components/common/PreferenceControls';

const { FormItem } = Form;

/**
 * Admin login page.
 */
export function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const { login, isLoading } = useAuth();
  const { t } = useTranslation();
  const [form] = Form.useForm();

  // Redirect if already authenticated
  React.useEffect(() => {
    useAuth.getState().loadFromStorage();
    if (useAuth.getState().isAuthenticated) {
      navigate('/admin', { replace: true });
    }
  }, [navigate]);

  const handleSubmit = async (): Promise<void> => {
    const validateResult = await form.validate();
    if (validateResult !== true) return;

    const values = form.getFieldsValue(['username', 'password']);
    const username = values.username as string;
    const password = values.password as string;

    try {
      await login(username, password);
      MessagePlugin.success(t('login.success'));
      navigate('/admin', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('login.failure');
      MessagePlugin.error(message);
    }
  };

  return (
    <div className="app-login-shell">
      <div style={{ position: 'fixed', top: '16px', right: '16px' }}>
        <PreferenceControls />
      </div>
      <Card
        className="app-login-card"
        title={t('login.title')}
        headerBordered
      >
        <Form
          form={form}
          labelAlign="top"
          onSubmit={handleSubmit}
          resetType="initial"
        >
          <FormItem
            label={t('login.username')}
            name="username"
            rules={[{ required: true, message: t('login.usernamePlaceholder') }]}
          >
            <Input
              placeholder={t('login.usernamePlaceholder')}
              prefixIcon={<UserIcon />}
              size="large"
              clearable
              data-testid="login-username"
            />
          </FormItem>

          <FormItem
            label={t('login.password')}
            name="password"
            rules={[{ required: true, message: t('login.passwordPlaceholder') }]}
          >
            <Input
              type="password"
              placeholder={t('login.passwordPlaceholder')}
              prefixIcon={<LockOnIcon />}
              size="large"
              data-testid="login-password"
            />
          </FormItem>

          <FormItem>
            <Button
              type="submit"
              theme="primary"
              size="large"
              block
              loading={isLoading}
              data-testid="login-submit"
            >
              {t('login.submit')}
            </Button>
          </FormItem>
        </Form>
      </Card>
    </div>
  );
}

export default LoginPage;
