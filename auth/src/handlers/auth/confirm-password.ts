import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ConfirmForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, serverError, normalizeEmail } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: string; code?: string; newPassword?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { email, code, newPassword } = body;
  if (!email || !code || !newPassword) {
    return badRequest('Validation failed', { email: 'required', code: 'required', newPassword: 'required' });
  }

  try {
    await cognito.send(
      new ConfirmForgotPasswordCommand({
        ClientId: process.env.COGNITO_CLIENT_ID!,
        Username: normalizeEmail(email),
        ConfirmationCode: code.trim(),
        Password: newPassword,
      })
    );
    return ok({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    switch (awsErrorName(err)) {
      case 'CodeMismatchException':
      case 'ExpiredCodeException':
        return badRequest('Invalid or expired reset code');
      case 'InvalidPasswordException':
        return badRequest('Password must be at least 8 characters with upper, lower case letters and a number');
    }
    console.error('confirm-password error', err);
    return serverError();
  }
};
