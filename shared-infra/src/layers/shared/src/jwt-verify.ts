import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

export interface CognitoClaims {
  sub: string;
  email: string;
  groups: string[];
}

export function getClaims(event: APIGatewayProxyEventV2WithJWTAuthorizer): CognitoClaims {
  const { claims } = event.requestContext.authorizer.jwt;
  const groupsRaw = claims['cognito:groups'];
  const groups = groupsRaw
    ? Array.isArray(groupsRaw)
      ? (groupsRaw as string[])
      : (groupsRaw as string).replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean)
    : [];

  return {
    sub: claims['sub'] as string,
    email: claims['email'] as string,
    groups,
  };
}

export const isAdmin = (event: APIGatewayProxyEventV2WithJWTAuthorizer) =>
  getClaims(event).groups.includes('Admins');

export const isStaff = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const { groups } = getClaims(event);
  return groups.includes('Staff') || groups.includes('Admins');
};
