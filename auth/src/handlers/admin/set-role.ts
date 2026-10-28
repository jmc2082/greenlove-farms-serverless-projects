import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  AdminListGroupsForUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { getDb, getClaims, isAdmin, ok, badRequest, forbidden, notFound, serverError, normalizeEmail } from '@greenlove/shared';
import { cognito, awsErrorName } from '../../lib/cognito';

const ROLE_GROUPS = {
  CUSTOMER: [],
  STAFF: ['Staff'],
  ADMIN: ['Admins'],
} as const;
type Role = keyof typeof ROLE_GROUPS;
const ELEVATED_GROUPS = ['Staff', 'Admins'];

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isAdmin(event)) return forbidden('Admin role required');

  let body: { email?: string; role?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { role } = body;
  if (!body.email) return badRequest('email is required');
  if (!role || !(role in ROLE_GROUPS)) return badRequest(`role must be one of: ${Object.keys(ROLE_GROUPS).join(', ')}`);

  const email = normalizeEmail(body.email);
  const actor = getClaims(event);
  // The access token has no email claim; the self-demotion guard needs the ID token.
  if (!actor.email) return badRequest('Authorize with the ID token, not the access token');
  if (normalizeEmail(actor.email) === email) return forbidden('You cannot change your own role');

  const userPoolId = process.env.COGNITO_USER_POOL_ID!;
  const target: readonly string[] = ROLE_GROUPS[role as Role];

  try {
    const { Groups } = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: email })
    );
    const current = (Groups ?? []).map((g) => g.GroupName!);

    // Everyone stays in Customers; only the elevated groups are swapped.
    const toRemove = current.filter((g) => ELEVATED_GROUPS.includes(g) && !target.includes(g));
    const toAdd = target.filter((g) => !current.includes(g));

    for (const GroupName of toRemove) {
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName }));
    }
    for (const GroupName of toAdd) {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName }));
    }

    const db = await getDb();
    await db.collection('adminAuditLog').insertOne({
      action: 'set_role',
      actorSub: actor.sub,
      actorEmail: actor.email,
      targetEmail: email,
      role,
      previousGroups: current,
      createdAt: new Date(),
    });

    return ok({ message: `${email} is now ${role}. It takes effect the next time they sign in or refresh.` });
  } catch (err) {
    if (awsErrorName(err) === 'UserNotFoundException') {
      return notFound('No account exists for that email');
    }
    console.error('set-role error', err);
    return serverError();
  }
};
