import { Db } from 'mongodb';
import { Cart, Product, availableUnits } from '@greenlove/shared';

export type LineAvailability = 'OK' | 'LIMITED' | 'UNAVAILABLE';

/**
 * Joins cart lines to current catalog data. Prices shown here are indicative only —
 * checkout re-prices server-side. UNAVAILABLE lines (archived product, removed variant)
 * are excluded from the subtotal; LIMITED means fewer units in stock than requested.
 */
export async function toCartView(db: Db, cart: Cart | null) {
  if (!cart) return { cartId: null, status: 'ACTIVE', lines: [], itemCount: 0, subtotalCents: 0, contact: null };

  const products = await db
    .collection<Product>('products')
    .find({ _id: { $in: cart.items.map((i) => i.productId) } })
    .toArray();
  const byId = new Map(products.map((p) => [p._id.toHexString(), p]));

  let subtotalCents = 0;
  let itemCount = 0;

  const lines = cart.items.map((item) => {
    const product = byId.get(item.productId.toHexString());
    const variant = product?.variants.find((v) => v._id.equals(item.variantId));
    const base = { productId: item.productId.toHexString(), variantId: item.variantId.toHexString(), qty: item.qty };

    if (!product || !variant || product.status !== 'ACTIVE') {
      return { ...base, availability: 'UNAVAILABLE' as LineAvailability, available: 0, product: null, variant: null, lineTotalCents: 0 };
    }

    const available = availableUnits(variant);
    const availability: LineAvailability = available !== null && available < item.qty ? 'LIMITED' : 'OK';
    const lineTotalCents = variant.priceCents * item.qty;
    subtotalCents += lineTotalCents;
    itemCount += item.qty;

    return {
      ...base,
      availability,
      available,
      product: {
        slug: product.slug,
        name: product.name,
        fulfillmentClass: product.fulfillmentClass,
        methods: product.fulfillmentProfile.methods,
        image: product.images[0] ?? null,
      },
      variant: { sku: variant.sku, name: variant.name, priceCents: variant.priceCents },
      lineTotalCents,
    };
  });

  return {
    cartId: cart._id,
    status: cart.status,
    lines,
    itemCount,
    subtotalCents,
    contact: cart.contact ? { email: cart.contact.email, marketingEmail: cart.contact.marketingEmail.granted } : null,
    updatedAt: cart.updatedAt,
  };
}
