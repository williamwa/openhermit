export { loadEnv, resolveOpenHermitHome } from './env.js';

export interface JsonErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export type OpenHermitStatusCode = 400 | 401 | 404 | 409 | 500;

export class OpenHermitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: OpenHermitStatusCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConflictError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'conflict', 409);
  }
}

export class ValidationError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'validation_error', 400);
  }
}

export class NotFoundError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'not_found', 404);
  }
}

export class UnauthorizedError extends OpenHermitError {
  constructor(message: string) {
    super(message, 'unauthorized', 401);
  }
}

export const internalStateFiles = {
  config: 'config.json',
  runtime: 'runtime.json',
} as const;

export interface RuntimeStateFile {
  http_api: {
    port: number;
    token: string;
  };
  updated_at: string;
}

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
};

export const jsonError = (
  error: unknown,
  fallbackCode = 'internal_error',
): JsonErrorBody => {
  if (error instanceof OpenHermitError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: fallbackCode,
      message: getErrorMessage(error),
    },
  };
};

export const joinUrl = (baseUrl: string, path: string): string => {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};
