import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { Db, ObjectId } from 'mongodb';
import { Customer, getClaims } from '@greenlove/shared';

// The signed-in shopper's customers record. Orders placed as a guest with the same email belong to it too:
// guest checkout files them under that email's record, which the account claims when it's confirmed.
export async function customerIdFor(db: Db, event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<ObjectId | null> {
  const c = await db.collection<Customer>('customers').findOne({ cognitoSub: getClaims(event).sub }, { projection: { _id: 1 } });
  return c?._id ?? null;
}
