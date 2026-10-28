import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, unauthorized, serverError } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { refreshToken?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { refreshToken } = body;
  if (!refreshToken) return badRequest('refreshToken is required');

  try {
    const { AuthenticationResult } = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: process.env.COGNITO_CLIENT_ID!,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      })
    );

    return ok({
      idToken: AuthenticationResult?.IdToken,
      accessToken: AuthenticationResult?.AccessToken,
      expiresIn: AuthenticationResult?.ExpiresIn,
    });
  } catch (err) {
    if (awsErrorName(err) === 'NotAuthorizedException') {
      return unauthorized('Refresh token is invalid or expired');
    }
    console.error('refresh error', err);
    return serverError();
  }
};
