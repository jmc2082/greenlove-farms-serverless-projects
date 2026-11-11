import { ObjectId } from 'mongodb';
import {
  FULFILLMENT_CLASSES, FulfillmentClass, Promotion, PROMOTION_SCOPES, PROMOTION_STATUSES, PROMOTION_TYPES,
  PROMO_CODE_PATTERN, PromotionScope, PromotionStatus, PromotionType, normalizePromoCode,
} from '@greenlove/shared';

export type EditableFields = Pick<
  Promotion,
  'code' | 'description' | 'type' | 'value' | 'appliesTo' | 'minSubtotalCents' | 'maxDiscountCents'
  | 'startsAt' | 'endsAt' | 'usageLimit' | 'perCustomerLimit' | 'firstOrderOnly' | 'status'
>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CENTS = 1_000_000_00;

type Errors = Record<string, string>;

const intOrNull = (raw: unknown, key: string, errors: Errors, min: number, max: number): number | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    errors[key] = `must be a whole number from ${min} to ${max}, or null`;
    return null;
  }
  return raw;
};

const dateOrNull = (raw: unknown, key: string, errors: Errors): Date | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = typeof raw === 'string' || raw instanceof Date ? new Date(raw) : new Date(NaN);
  if (Number.isNaN(d.getTime())) {
    errors[key] = 'must be an ISO date-time, or null';
    return null;
  }
  return d;
};

/**
 * Validates a whole promotion (create, or the current one merged with changes on update).
 * Amounts are integer cents; PERCENT value is 1–100. Fields that don't apply to the type are cleared.
 */
export function validatePromotion(raw: Record<string, unknown>): { fields?: EditableFields; errors?: Errors } {
  const errors: Errors = {};

  const code = typeof raw['code'] === 'string' ? normalizePromoCode(raw['code']) : '';
  if (!PROMO_CODE_PATTERN.test(code)) errors['code'] = '3–32 letters, numbers, - or _';

  const description = typeof raw['description'] === 'string' ? raw['description'].trim().slice(0, 200) : '';

  const type = raw['type'] as PromotionType;
  if (!PROMOTION_TYPES.includes(type)) errors['type'] = `one of ${PROMOTION_TYPES.join(', ')}`;

  let value = 0;
  if (type === 'PERCENT' || type === 'FIXED') {
    const max = type === 'PERCENT' ? 100 : MAX_CENTS;
    if (typeof raw['value'] !== 'number' || !Number.isInteger(raw['value']) || raw['value'] < 1 || raw['value'] > max) {
      errors['value'] = type === 'PERCENT' ? 'a whole percent from 1 to 100' : 'cents, at least 1';
    } else {
      value = raw['value'];
    }
  }

  const rawApplies = (raw['appliesTo'] ?? { scope: 'ORDER', ids: [] }) as { scope?: unknown; ids?: unknown };
  const scope = rawApplies.scope as PromotionScope;
  let ids: string[] = [];
  if (!PROMOTION_SCOPES.includes(scope)) {
    errors['appliesTo.scope'] = `one of ${PROMOTION_SCOPES.join(', ')}`;
  } else if (scope !== 'ORDER') {
    const list = Array.isArray(rawApplies.ids) ? rawApplies.ids : [];
    ids = [...new Set(list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()))].slice(0, 100);
    const ok =
      scope === 'CATEGORIES' ? (x: string) => SLUG.test(x) :
      scope === 'PRODUCTS' ? (x: string) => ObjectId.isValid(x) && x.length === 24 :
      (x: string) => FULFILLMENT_CLASSES.includes(x as FulfillmentClass);
    if (ids.length === 0 || ids.length !== list.length || !ids.every(ok)) {
      errors['appliesTo.ids'] =
        scope === 'CATEGORIES' ? 'at least one category slug' :
        scope === 'PRODUCTS' ? 'at least one product id' : `at least one of ${FULFILLMENT_CLASSES.join(', ')}`;
    }
  }

  const minSubtotalCents = intOrNull(raw['minSubtotalCents'], 'minSubtotalCents', errors, 0, MAX_CENTS);
  const maxDiscountCents = type === 'PERCENT' ? intOrNull(raw['maxDiscountCents'], 'maxDiscountCents', errors, 1, MAX_CENTS) : null;
  const startsAt = dateOrNull(raw['startsAt'], 'startsAt', errors);
  const endsAt = dateOrNull(raw['endsAt'], 'endsAt', errors);
  if (startsAt && endsAt && endsAt <= startsAt) errors['endsAt'] = 'must be after startsAt';
  const usageLimit = intOrNull(raw['usageLimit'], 'usageLimit', errors, 1, 1_000_000);
  const perCustomerLimit = intOrNull(raw['perCustomerLimit'], 'perCustomerLimit', errors, 1, 1000);

  if (raw['firstOrderOnly'] !== undefined && typeof raw['firstOrderOnly'] !== 'boolean') errors['firstOrderOnly'] = 'must be true or false';
  const firstOrderOnly = raw['firstOrderOnly'] === true;

  const status = (raw['status'] ?? 'ACTIVE') as PromotionStatus;
  if (!PROMOTION_STATUSES.includes(status)) errors['status'] = `one of ${PROMOTION_STATUSES.join(', ')}`;

  if (Object.keys(errors).length > 0) return { errors };
  return {
    fields: {
      code, description, type, value, appliesTo: { scope, ids }, minSubtotalCents, maxDiscountCents,
      startsAt, endsAt, usageLimit, perCustomerLimit, firstOrderOnly, status,
    },
  };
}

export const toEditableInput = (p: Promotion): Record<string, unknown> => ({
  code: p.code, description: p.description, type: p.type, value: p.value, appliesTo: p.appliesTo,
  minSubtotalCents: p.minSubtotalCents, maxDiscountCents: p.maxDiscountCents, startsAt: p.startsAt, endsAt: p.endsAt,
  usageLimit: p.usageLimit, perCustomerLimit: p.perCustomerLimit, firstOrderOnly: p.firstOrderOnly, status: p.status,
});

// What staff see in the list: ACTIVE codes split by their dates and usage.
export type PromotionState = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'USED_UP' | 'PAUSED' | 'ARCHIVED';

export function promotionState(p: Promotion, now: Date): PromotionState {
  if (p.status !== 'ACTIVE') return p.status;
  if (p.endsAt && now >= p.endsAt) return 'EXPIRED';
  if (p.usageLimit !== null && p.redemptionCount >= p.usageLimit) return 'USED_UP';
  if (p.startsAt && now < p.startsAt) return 'SCHEDULED';
  return 'ACTIVE';
}
