import { PostConfirmationTriggerHandler } from 'aws-lambda';
import { AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getDb, Customer, normalizeEmail } from '@greenlove/shared';
import { cognito } from '../../lib/cognito';

export const handler: PostConfirmationTriggerHandler = async (event) => {
  // Also fires after a forgotten-password reset; only first-time signup confirmation links accounts.
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;

  const { userPoolId, userName, request } = event;
  const email = normalizeEmail(request.userAttributes['email']);
  const sub = request.userAttributes['sub'];
  const name = request.userAttributes['name'] ?? '';

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: userName,
      GroupName: 'Customers',
    })
  );

  // Email is now verified, so it is safe to claim an existing guest record (and with it, past orders).
  const now = new Date();
  const db = await getDb();
  await db.collection<Customer>('customers').updateOne(
    { email },
    {
      $set: { cognitoSub: sub, updatedAt: now },
      $setOnInsert: {
        email,
        fullName: name,
        phone: '',
        addresses: [],
        consent: { marketingEmail: null, sms: null },
        createdAt: now,
      },
    },
    { upsert: true }
  );

  return event;
};
