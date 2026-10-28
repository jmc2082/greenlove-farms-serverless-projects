import { APIGatewayProxyResultV2 } from 'aws-lambda';

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const ok = (data: unknown) => json(200, data);
export const created = (data: unknown) => json(201, data);
export const noContent = (): APIGatewayProxyResultV2 => ({ statusCode: 204, body: '' });

export const badRequest = (message: string, details?: unknown) =>
  json(400, { error: message, ...(details ? { details } : {}) });

export const unauthorized = (message = 'Unauthorized') => json(401, { error: message });
export const forbidden = (message = 'Forbidden') => json(403, { error: message });
export const notFound = (message = 'Not found') => json(404, { error: message });
export const conflict = (message: string) => json(409, { error: message });
export const serverError = (message = 'Internal server error') => json(500, { error: message });
