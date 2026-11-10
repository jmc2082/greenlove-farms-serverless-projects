import { ObjectId } from 'mongodb';
import {
  Product,
  ProductVariant,
  ProductImage,
  FulfillmentClass,
  FulfillmentMethod,
  FulfillmentProfile,
  ProductBadge,
  ProductLabel,
  PRODUCT_BADGES,
  FULFILLMENT_CLASSES,
  FULFILLMENT_METHODS,
  REGULATORY_CLASSES,
  PRODUCT_STATUSES,
  RegulatoryClass,
  ProductStatus,
} from '@greenlove/shared';

export type ProductFields = Omit<Product, '_id' | 'version' | 'createdAt' | 'updatedAt'>;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKU = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const MAX_VARIANTS = 20;
const MAX_IMAGES = 10;
const MAX_PRICE_CENTS = 1_000_000;
const MAX_SEARCH_TERMS = 20;
const MAX_ALLERGENS = 20;

// Regulatory classes whose label (ingredients) must be filled in before the product can be ACTIVE.
const NEEDS_INGREDIENTS: RegulatoryClass[] = ['COSMETIC', 'COTTAGE_FOOD', 'TCS'];

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Trimmed, de-duplicated list of non-empty strings. Returns null when `v` isn't an array of strings.
function textList(v: unknown, maxItems: number, maxLen: number, lower = false): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === 'string')) return null;
  const out = v.map((x: string) => (lower ? x.toLowerCase() : x).trim().slice(0, maxLen)).filter(Boolean);
  return [...new Set(out)];
}

// Inverse of validation: what an admin client sends back (variant ids as strings, inventory omitted).
export function toEditableInput(p: Product): Record<string, unknown> {
  return {
    slug: p.slug,
    name: p.name,
    description: p.description,
    shortDescription: p.shortDescription,
    searchTerms: p.searchTerms,
    label: p.label,
    storage: p.storage,
    featuredRank: p.featuredRank,
    badges: p.badges,
    category: p.category,
    status: p.status,
    fulfillmentClass: p.fulfillmentClass,
    fulfillmentProfile: p.fulfillmentProfile,
    regulatoryClass: p.regulatoryClass,
    taxCategory: p.taxCategory,
    images: p.images,
    variants: p.variants.map((v) => ({
      id: v._id.toHexString(),
      sku: v.sku,
      name: v.name,
      priceCents: v.priceCents,
      weightOz: v.weightOz,
      netWeight: v.netWeight,
    })),
  };
}

/**
 * Validates a full product payload. `existingVariants` (update only) lets variants keep their _id and
 * inventory counters — inventory is never set through this path except `onHand` on new variants.
 */
export function validateProduct(
  raw: Record<string, unknown>,
  imageFolder: string,
  existingVariants: ProductVariant[] = []
): { product?: ProductFields; errors?: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = text(raw['name'], 120);
  if (!name) errors['name'] = 'required, 1-120 characters';

  const slug = raw['slug'] === undefined || raw['slug'] === '' ? slugify(name) : text(raw['slug'], 80);
  if (!SLUG.test(slug)) errors['slug'] = 'lowercase letters, numbers and single hyphens';

  const description = text(raw['description'], 5000);
  const shortDescription = text(raw['shortDescription'], 160);
  const storage = text(raw['storage'], 1000);

  const searchTerms = textList(raw['searchTerms'], MAX_SEARCH_TERMS, 40, true);
  if (!searchTerms) errors['searchTerms'] = `array of at most ${MAX_SEARCH_TERMS} strings`;

  const badges = textList(raw['badges'], PRODUCT_BADGES.length, 20) as ProductBadge[] | null;
  if (!badges || !badges.every((b) => PRODUCT_BADGES.includes(b))) {
    errors['badges'] = `array of ${PRODUCT_BADGES.join(', ')}`;
  }

  const featuredRank = raw['featuredRank'] ?? 0;
  if (!isInt(featuredRank, 0, 1000)) errors['featuredRank'] = 'integer 0-1000 (higher shows first, 0 = not featured)';

  const category = text(raw['category'], 60);
  if (!category) errors['category'] = 'required';

  const status = (raw['status'] ?? 'DRAFT') as ProductStatus;
  if (!PRODUCT_STATUSES.includes(status)) errors['status'] = `one of ${PRODUCT_STATUSES.join(', ')}`;

  const fulfillmentClass = raw['fulfillmentClass'] as FulfillmentClass;
  if (!FULFILLMENT_CLASSES.includes(fulfillmentClass)) {
    errors['fulfillmentClass'] = `one of ${FULFILLMENT_CLASSES.join(', ')}`;
  } else if (status === 'ACTIVE' && fulfillmentClass !== 'STOCKED') {
    // Phase 1 checkout only quotes stocked items; other classes can be drafted but not sold yet.
    errors['status'] = `${fulfillmentClass} products cannot be ACTIVE until checkout supports them — keep as DRAFT`;
  }

  const regulatoryClass = raw['regulatoryClass'] as RegulatoryClass;
  if (!REGULATORY_CLASSES.includes(regulatoryClass)) {
    errors['regulatoryClass'] = `one of ${REGULATORY_CLASSES.join(', ')}`;
  }

  const taxCategory = text(raw['taxCategory'], 40);
  if (!taxCategory) errors['taxCategory'] = 'required';

  // ── Label ──
  let label: ProductLabel | undefined;
  if (raw['label'] !== undefined && raw['label'] !== null) {
    const rl = raw['label'] as Record<string, unknown>;
    const allergens = typeof rl === 'object' ? textList(rl['allergens'], MAX_ALLERGENS, 60) : null;
    if (typeof rl !== 'object' || Array.isArray(rl) || !allergens) {
      errors['label'] = `{ ingredients, allergens: string[] (at most ${MAX_ALLERGENS}), statement? }`;
    } else {
      const statement = text(rl['statement'], 500);
      label = { ingredients: text(rl['ingredients'], 3000), allergens, ...(statement ? { statement } : {}) };
    }
  }
  if (status === 'ACTIVE' && !errors['label']) {
    // Customers must be able to read the label before paying, so a sellable product needs one.
    if (NEEDS_INGREDIENTS.includes(regulatoryClass) && !label?.ingredients) {
      errors['label.ingredients'] = `required before a ${regulatoryClass} product can be ACTIVE`;
    }
    if (regulatoryClass === 'COTTAGE_FOOD' && !label?.statement) {
      errors['label.statement'] = 'the cottage-food statement is required before a COTTAGE_FOOD product can be ACTIVE';
    }
  }

  // ── Fulfillment profile ──
  const fp = (raw['fulfillmentProfile'] ?? {}) as Record<string, unknown>;
  const methods = Array.isArray(fp['methods']) ? [...new Set(fp['methods'] as FulfillmentMethod[])] : [];
  const perishable = fp['perishable'] === true;
  const fulfillmentProfile: FulfillmentProfile = { methods, perishable };

  if (methods.length === 0 || !methods.every((m) => FULFILLMENT_METHODS.includes(m))) {
    errors['fulfillmentProfile.methods'] = `non-empty subset of ${FULFILLMENT_METHODS.join(', ')}`;
  } else if (methods.includes('SHIP') && (perishable || regulatoryClass === 'TCS')) {
    errors['fulfillmentProfile.methods'] = 'perishable / TCS products cannot be shipped — local delivery or pickup only';
  }

  if (fulfillmentClass === 'STOCKED') {
    if (!isInt(fp['handlingDays'], 0, 30)) errors['fulfillmentProfile.handlingDays'] = 'required for STOCKED, 0-30';
    else fulfillmentProfile.handlingDays = fp['handlingDays'];
  }
  if (fulfillmentClass === 'GROW_TO_ORDER') {
    const lt = (fp['leadTimeDays'] ?? {}) as Record<string, unknown>;
    if (!isInt(lt['min'], 1, 120) || !isInt(lt['max'], 1, 120) || lt['min'] > lt['max']) {
      errors['fulfillmentProfile.leadTimeDays'] = 'required for GROW_TO_ORDER: { min, max } days, 1-120, min <= max';
    } else {
      fulfillmentProfile.leadTimeDays = { min: lt['min'], max: lt['max'] };
    }
  }

  // ── Images ──
  const images: ProductImage[] = [];
  if (raw['images'] !== undefined) {
    if (!Array.isArray(raw['images']) || raw['images'].length > MAX_IMAGES) {
      errors['images'] = `array of at most ${MAX_IMAGES}`;
    } else {
      for (const [i, img] of (raw['images'] as Record<string, unknown>[]).entries()) {
        const publicId = text(img?.['publicId'], 200);
        if (!publicId.startsWith(`${imageFolder}/`)) {
          errors[`images[${i}].publicId`] = `must be an upload in ${imageFolder}/`;
          continue;
        }
        images.push({ publicId, alt: text(img['alt'], 200) || name });
      }
    }
  }

  // ── Variants ──
  const existingById = new Map(existingVariants.map((v) => [v._id.toHexString(), v]));
  const variants: ProductVariant[] = [];
  const rawVariants = raw['variants'];

  if (!Array.isArray(rawVariants) || rawVariants.length === 0 || rawVariants.length > MAX_VARIANTS) {
    errors['variants'] = `1-${MAX_VARIANTS} variants required`;
  } else {
    const skus = new Set<string>();
    for (const [i, rv] of (rawVariants as Record<string, unknown>[]).entries()) {
      const at = `variants[${i}]`;
      const sku = text(rv?.['sku'], 40).toUpperCase();
      const vName = text(rv?.['name'], 80);
      const priceCents = rv?.['priceCents'];
      const weightOz = rv?.['weightOz'];
      const netWeight = text(rv?.['netWeight'], 40);
      const id = rv?.['id'];

      if (!SKU.test(sku)) errors[`${at}.sku`] = 'A-Z, 0-9 and hyphens, 2-40 characters';
      else if (skus.has(sku)) errors[`${at}.sku`] = 'duplicate SKU';
      skus.add(sku);
      if (!vName) errors[`${at}.name`] = 'required';
      if (!isInt(priceCents, 0, MAX_PRICE_CENTS)) errors[`${at}.priceCents`] = 'integer cents';
      if (weightOz !== undefined && (typeof weightOz !== 'number' || weightOz < 0 || weightOz > 1600)) {
        errors[`${at}.weightOz`] = 'number of ounces';
      }

      const existing = typeof id === 'string' ? existingById.get(id) : undefined;
      if (id !== undefined && !existing) {
        errors[`${at}.id`] = 'unknown variant id';
        continue;
      }

      let inventory: ProductVariant['inventory'];
      if (fulfillmentClass === 'STOCKED') {
        if (existing?.inventory) {
          inventory = existing.inventory;
        } else {
          const onHand = rv?.['onHand'] ?? 0;
          if (!isInt(onHand, 0, 100_000)) errors[`${at}.onHand`] = 'integer >= 0';
          inventory = { onHand: onHand as number, held: 0 };
        }
      }

      variants.push({
        _id: existing?._id ?? new ObjectId(),
        sku,
        name: vName,
        priceCents: priceCents as number,
        ...(typeof weightOz === 'number' ? { weightOz } : {}),
        ...(netWeight ? { netWeight } : {}),
        ...(inventory ? { inventory } : {}),
      });
    }

    const keptIds = new Set(variants.map((v) => v._id.toHexString()));
    for (const old of existingVariants) {
      if (!keptIds.has(old._id.toHexString()) && (old.inventory?.held ?? 0) > 0) {
        errors['variants'] = `variant ${old.sku} has units held by in-progress checkouts and cannot be removed yet`;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { errors };

  return {
    product: {
      slug,
      name,
      description,
      shortDescription,
      searchTerms: searchTerms!,
      ...(label ? { label } : {}),
      storage,
      featuredRank: featuredRank as number,
      badges: badges!,
      category,
      status,
      fulfillmentClass,
      fulfillmentProfile,
      regulatoryClass,
      taxCategory,
      images,
      variants,
    },
  };
}
