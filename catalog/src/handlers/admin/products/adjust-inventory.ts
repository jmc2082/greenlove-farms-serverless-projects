import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, getClaims, isStaff, ok, badRequest, forbidden, conflict, serverError, Product, toAdminProduct } from '@greenlove/shared';

const REASONS = ['RESTOCK', 'COUNT_CORRECTION', 'DAMAGED', 'MARKET_SALE', 'OTHER'] as const;
type Reason = (typeof REASONS)[number];

// Atomic $inc on one variant's onHand; refuses to go below zero. Every adjustment is logged.
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  const id = event.pathParameters?.['id'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid product ID');

  let body: { variantId?: string; delta?: number; reason?: string; note?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { variantId, delta, reason } = body;
  if (!variantId || !ObjectId.isValid(variantId)) return badRequest('variantId is required');
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) {
    return badRequest('delta must be a non-zero integer');
  }
  if (!REASONS.includes(reason as Reason)) return badRequest(`reason must be one of: ${REASONS.join(', ')}`);

  const productId = new ObjectId(id);
  const vId = new ObjectId(variantId);
  const actor = getClaims(event);

  try {
    const db = await getDb();
    const result = await db.collection<Product>('products').findOneAndUpdate(
      {
        _id: productId,
        fulfillmentClass: 'STOCKED',
        variants: { $elemMatch: { _id: vId, 'inventory.onHand': { $gte: Math.max(0, -delta) } } },
      },
      {
        $inc: { 'variants.$[v].inventory.onHand': delta, version: 1 },
        $set: { updatedAt: new Date() },
      },
      { arrayFilters: [{ 'v._id': vId }], returnDocument: 'after' }
    );

    if (!result) {
      return conflict('Product/variant not found, not a STOCKED product, or not enough stock for that decrease');
    }

    const variant = result.variants.find((v) => v._id.equals(vId))!;
    await db.collection('inventoryAdjustments').insertOne({
      productId,
      variantId: vId,
      sku: variant.sku,
      delta,
      reason,
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined,
      onHandAfter: variant.inventory!.onHand,
      actorSub: actor.sub,
      actorEmail: actor.email,
      createdAt: new Date(),
    });

    return ok(toAdminProduct(result));
  } catch (err) {
    console.error('admin-adjust-inventory error', err);
    return serverError();
  }
};
