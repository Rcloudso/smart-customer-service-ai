/**
 * HTTP client wrapper with JWT auth injection and unified error handling.
 */
import { usePreferences } from '../hooks/usePreferences';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: number;
  public readonly data: unknown;

  constructor(statusCode: number, code: number, message: string, data: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

const BASE_URL = '/api';

type UnauthorizedHandler = (requestToken: string) => void;

interface RequestOptions {
  auth?: boolean;
}

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

function t(key: string, params?: Record<string, string | number>): string {
  return usePreferences.getState().t(key, params);
}

function getToken(): string | null {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

function handleUnauthorized(response: Response, requestToken: string | null): void {
  if (response.status === 401 && requestToken) {
    unauthorizedHandler?.(requestToken);
  }
}

async function handleResponse<T>(response: Response, requestToken: string | null): Promise<T> {
  handleUnauthorized(response, requestToken);

  if (response.status === 204) {
    return null as T;
  }

  let body: { code: number; data: T; message: string } | null = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      body = await response.json();
    } catch (err) {
      if (response.ok) {
        throw err;
      }
    }
  }

  if (!response.ok) {
    const message = body?.message || `HTTP ${response.status}`;
    const code = body?.code || response.status;
    throw new ApiError(response.status, code, message, body?.data);
  }

  if (body && body.data !== undefined) {
    return body.data as T;
  }

  return null as T;
}

export async function get<T = unknown>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
  });

  return handleResponse<T>(response, token);
}

export async function post<T = unknown>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  const token = options.auth === false ? null : getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return handleResponse<T>(response, token);
}

export async function put<T = unknown>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return handleResponse<T>(response, token);
}

export async function del<T = unknown>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers,
  });

  return handleResponse<T>(response, token);
}

export async function uploadFile<T = unknown>(path: string, file: File, fieldName: string = 'file'): Promise<T> {
  const formData = new FormData();
  formData.append(fieldName, file);

  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });

  return handleResponse<T>(response, token);
}

export async function downloadBlob(path: string, filename: string): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, { headers });

  if (!response.ok) {
    await handleResponse<never>(response, token);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
