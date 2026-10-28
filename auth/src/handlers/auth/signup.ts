import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { created, badRequest, serverError, normalizeEmail } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

// Deliberately does not touch MongoDB: the customer record is linked/created only after the
// email is confirmed (post-confirmation trigger), so nobody can claim a guest's history by signing up with their email.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: string; password?: string; fullName?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { email, password, fullName } = body;
  if (!email || !password) {
    return badRequest('Validation failed', { email: 'required', password: 'required' });
  }

  const userAttributes = [{ Name: 'email', Value: normalizeEmail(email) }];
  if (fullName?.trim()) userAttributes.push({ Name: 'name', Value: fullName.trim().slice(0, 100) });

  try {
    await cognito.send(
      new SignUpCommand({
        ClientId: process.env.COGNITO_CLIENT_ID!,
        Username: normalizeEmail(email),
        Password: password,
        UserAttributes: userAttributes,
      })
    );
    return created({ message: 'Account created. Check your email for a verification code.' });
  } catch (err) {
    switch (awsErrorName(err)) {
      case 'UsernameExistsException':
        return badRequest('An account with this email already exists');
      case 'InvalidPasswordException':
        return badRequest('Password must be at least 8 characters with upper, lower case letters and a number');
      case 'InvalidParameterException':
        return badRequest('Invalid email address');
    }
    console.error('signup error', err);
    return serverError();
  }
};
