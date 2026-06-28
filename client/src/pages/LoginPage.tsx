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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        backgroundColor: 'var(--app-bg)',
      }}
    >
      <div style={{ position: 'fixed', top: '16px', right: '16px' }}>
        <PreferenceControls />
      </div>
      <Card
        style={{
          width: '400px',
          maxWidth: '90vw',
          boxShadow: 'var(--app-shadow)',
          backgroundColor: 'var(--app-surface)',
        }}
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
            />
          </FormItem>

          <FormItem>
            <Button
              type="submit"
              theme="primary"
              size="large"
              block
              loading={isLoading}
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
