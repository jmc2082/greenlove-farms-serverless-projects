import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ok } from '@greenlove/shared';

export const handler = async (): Promise<APIGatewayProxyResultV2> =>
  ok({
    service: 'orders',
    environment: process.env.ENVIRONMENT,
    version: process.env.SERVICE_VERSION,
    timestamp: new Date().toISOString(),
  });
