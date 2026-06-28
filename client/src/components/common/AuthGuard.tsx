import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * Route guard that checks authentication.
 * Reads auth state synchronously from localStorage on init, so there is no
 * flash redirect to /login on page refresh.
 */
export function AuthGuard({ children }: AuthGuardProps): React.ReactElement {
  const { isAuthenticated, isInitialized } = useAuth();

  // Show nothing while reading from localStorage (instant in practice)
  if (!isInitialized) {
    return <></>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export default AuthGuard;
