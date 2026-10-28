import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, unauthorized, tooManyRequests, serverError, normalizeEmail } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: string; password?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { email, password } = body;
  if (!email || !password) {
    return badRequest('Validation failed', { email: 'required', password: 'required' });
  }

  try {
    const { AuthenticationResult } = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.COGNITO_CLIENT_ID!,
        AuthParameters: { USERNAME: normalizeEmail(email), PASSWORD: password },
      })
    );

    // Send idToken as the Bearer token: it carries email + cognito:groups claims.
    return ok({
      idToken: AuthenticationResult?.IdToken,
      accessToken: AuthenticationResult?.AccessToken,
      refreshToken: AuthenticationResult?.RefreshToken,
      expiresIn: AuthenticationResult?.ExpiresIn,
    });
  } catch (err) {
    switch (awsErrorName(err)) {
      case 'NotAuthorizedException':
      case 'UserNotFoundException':
        return unauthorized('Invalid email or password');
      case 'UserNotConfirmedException':
        return unauthorized('Email not yet confirmed');
      case 'TooManyRequestsException':
      case 'LimitExceededException':
        return tooManyRequests('Too many attempts. Please wait a few minutes and try again.');
    }
    console.error('login error', err);
    return serverError();
  }
};
