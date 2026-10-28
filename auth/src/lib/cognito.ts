import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

export const cognito = new CognitoIdentityProviderClient({});

export const awsErrorName = (err: unknown) => (err as { name?: string }).name;
