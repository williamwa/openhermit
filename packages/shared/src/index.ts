export interface JsonErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export class CloudMindError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends CloudMindError {
  constructor(message: string) {
    super(message, 'validation_error', 400);
  }
}

export class NotFoundError extends CloudMindError {
  constructor(message: string) {
    super(message, 'not_found', 404);
  }
}

export const runtimeFiles = {
  apiPort: 'runtime/api.port',
  apiToken: 'runtime/api.token',
} as const;

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
  if (error instanceof CloudMindError) {
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
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};
