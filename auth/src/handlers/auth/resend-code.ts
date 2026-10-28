import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ResendConfirmationCodeCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, tooManyRequests, serverError, normalizeEmail } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { email } = body;
  if (!email) return badRequest('email is required');

  try {
    await cognito.send(
      new ResendConfirmationCodeCommand({
        ClientId: process.env.COGNITO_CLIENT_ID!,
        Username: normalizeEmail(email),
      })
    );
    return ok({ message: 'If that account is awaiting confirmation, a new code has been sent.' });
  } catch (err) {
    if (awsErrorName(err) === 'LimitExceededException') {
      return tooManyRequests('Too many attempts. Please wait a few minutes and try again.');
    }
    console.error('resend-code error', err);
    return serverError();
  }
};
