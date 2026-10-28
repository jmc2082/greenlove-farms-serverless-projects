import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ConfirmSignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, serverError, normalizeEmail } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: string; code?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { email, code } = body;
  if (!email || !code) {
    return badRequest('Validation failed', { email: 'required', code: 'required' });
  }

  try {
    await cognito.send(
      new ConfirmSignUpCommand({
        ClientId: process.env.COGNITO_CLIENT_ID!,
        Username: normalizeEmail(email),
        ConfirmationCode: code.trim(),
      })
    );
    return ok({ message: 'Account confirmed. You can now log in.' });
  } catch (err) {
    switch (awsErrorName(err)) {
      case 'CodeMismatchException':
      case 'ExpiredCodeException':
        return badRequest('Invalid or expired confirmation code');
      case 'NotAuthorizedException':
        return badRequest('Account is already confirmed');
    }
    console.error('confirm-signup error', err);
    return serverError();
  }
};
