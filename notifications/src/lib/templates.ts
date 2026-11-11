import { FulfillmentGroup, Order, OrderRefund, emailButton, emailLayout, escapeHtml } from '@greenlove/shared';

export interface RenderedEmail { subject: string; html: string; text: string }

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const firstName = (o: Order) => o.contact.fullName.trim().split(/\s+/)[0] || 'there';

// "Tuesday, November 12" from YYYY-MM-DD (a farm-time calendar date).
const day = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

function groupWhen(g: FulfillmentGroup): string {
  if (g.method === 'PICKUP') return `Pickup at ${g.pickupLocation?.name ?? 'the farm'}${g.deliveryDate ? `, ${day(g.deliveryDate)}` : ''}`;
  if (g.method === 'LOCAL_DELIVERY') return `Local delivery${g.deliveryDate ? `, ${day(g.deliveryDate)}` : ''}`;
  return g.shipsWithinDays ? `Ships within ${g.shipsWithinDays} business day${g.shipsWithinDays === 1 ? '' : 's'}` : 'Ships soon';
}

const addressLines = (g: FulfillmentGroup) =>
  g.address ? [g.address.name, g.address.line1, g.address.line2, `${g.address.city}, ${g.address.state} ${g.address.zip}`].filter(Boolean) as string[] : [];

function linkFor(link: string, placedBy: Order['placedBy']) {
  return placedBy === 'CUSTOMER' ? 'View your order' : 'Track your order';
}

// ── Order confirmation ────────────────────────────────────────────────────────

export function confirmationEmail(o: Order, link: string): RenderedEmail {
  const t = o.totals;
  const groupsHtml = o.fulfillmentGroups.map((g) => {
    const rows = g.items.map((i) => `<tr>
<td style="padding:6px 0">${escapeHtml(i.name)}<br><span style="color:#7a7f75;font-size:13px">${escapeHtml(i.variantName)} × ${i.qty}</span></td>
<td style="padding:6px 0;text-align:right;white-space:nowrap">${money(i.lineTotalCents)}</td></tr>`).join('');
    const addr = addressLines(g).map(escapeHtml).join('<br>');
    return `<h3 style="font-size:16px;margin:20px 0 4px">${escapeHtml(groupWhen(g))}</h3>
${addr ? `<p style="margin:0 0 8px;color:#5b6358;font-size:14px">${addr}</p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6e1d6">${rows}</table>`;
  }).join('');

  const line = (label: string, cents: number, negative = false) =>
    `<tr><td style="padding:3px 0;color:#5b6358">${label}</td><td style="padding:3px 0;text-align:right">${negative ? '−' : ''}${money(cents)}</td></tr>`;
  const totalsHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6e1d6;margin-top:12px;padding-top:8px">
${line('Subtotal', t.subtotalCents)}
${t.discountCents ? line(`Discount${o.promotion ? ` (${escapeHtml(o.promotion.code)})` : ''}`, t.discountCents, true) : ''}
${t.deliveryCents || o.fulfillmentGroups.some((g) => g.method === 'LOCAL_DELIVERY') ? line('Delivery', t.deliveryCents) : ''}
${t.shippingCents || o.fulfillmentGroups.some((g) => g.method === 'SHIP') ? line('Shipping', t.shippingCents) : ''}
${line('Sales tax', t.taxCents)}
<tr><td style="padding:8px 0 0;font-weight:bold">Total</td><td style="padding:8px 0 0;text-align:right;font-weight:bold">${money(t.totalCents)}</td></tr>
</table>`;
  const card = o.payment.method?.brand ? `<p style="color:#7a7f75;font-size:13px">Paid with ${escapeHtml(o.payment.method.brand)} ending ${escapeHtml(o.payment.method.last4 ?? '')}.</p>` : '';
  const split = o.fulfillmentGroups.length > 1 ? '<p>Your order arrives in parts. We’ll email you as each part is on its way.</p>' : '';
  const guestNote = o.placedBy === 'GUEST'
    ? '<p style="font-size:13px;color:#7a7f75">Keep this email: the button above is your private link to this order. Want order history and faster checkout? Create an account with this email address and your orders will be there.</p>'
    : '';

  const html = emailLayout(`Thank you, ${firstName(o)}!`,
    `<p>We’ve received your order <strong>${escapeHtml(o.orderNumber)}</strong>.</p>${split}
${emailButton(link, linkFor(link, o.placedBy))}
${groupsHtml}${totalsHtml}${card}${guestNote}
<p>Questions? Just reply to this email.</p>`);

  const text = [
    `Thank you, ${firstName(o)}!`, '',
    `We've received your order ${o.orderNumber}.`,
    `${linkFor(link, o.placedBy)}: ${link}`, '',
    ...o.fulfillmentGroups.flatMap((g) => [
      groupWhen(g), ...addressLines(g),
      ...g.items.map((i) => `  ${i.name} (${i.variantName}) × ${i.qty}  ${money(i.lineTotalCents)}`), '',
    ]),
    `Subtotal ${money(t.subtotalCents)}`,
    ...(t.discountCents ? [`Discount -${money(t.discountCents)}`] : []),
    ...(t.deliveryCents ? [`Delivery ${money(t.deliveryCents)}`] : []),
    ...(t.shippingCents ? [`Shipping ${money(t.shippingCents)}`] : []),
    `Sales tax ${money(t.taxCents)}`,
    `Total ${money(t.totalCents)}`, '',
    'Questions? Just reply to this email.', 'GreenLove Farms',
  ].join('\n');

  return { subject: `Order ${o.orderNumber} confirmed`, html, text };
}

// ── Status updates (only the ones a shopper needs to act on or wait for) ──────

export const STATUS_EMAILS = ['SHIPPED', 'READY', 'OUT_FOR_DELIVERY', 'CANCELLED'] as const;

export function statusEmail(o: Order, g: FulfillmentGroup, link: string | null): RenderedEmail | null {
  const items = g.items.map((i) => `${i.name} (${i.variantName}) × ${i.qty}`);
  let heading: string;
  let body: string;
  if (g.status === 'SHIPPED') {
    heading = 'Your order is on its way';
    body = g.trackingNumber
      ? `Tracking number: <strong>${escapeHtml(g.trackingNumber)}</strong>${g.trackingUrl ? `<br><a href="${escapeHtml(g.trackingUrl)}" style="color:#4a7c3f">Track the package</a>` : ''}`
      : 'It has left the farm.';
  } else if (g.status === 'READY' && g.method === 'PICKUP') {
    heading = 'Ready for pickup';
    body = `Your order is ready at ${escapeHtml(g.pickupLocation?.name ?? 'the farm')}${g.deliveryDate ? ` for ${escapeHtml(day(g.deliveryDate))}` : ''}.`;
  } else if (g.status === 'OUT_FOR_DELIVERY') {
    heading = 'Out for delivery';
    body = 'Your order is on the truck and arriving today.';
  } else if (g.status === 'CANCELLED') {
    heading = 'Part of your order was cancelled';
    body = 'We’re sorry: we had to cancel the items below. If you were charged for them, we’ll refund you and send a separate email.';
  } else {
    return null;
  }

  const plain = body.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '');
  const html = emailLayout(heading, `<p>Hi ${escapeHtml(firstName(o))},</p><p>${body}</p>
<p style="color:#5b6358;font-size:14px">Order ${escapeHtml(o.orderNumber)}:<br>${items.map(escapeHtml).join('<br>')}</p>
${link ? emailButton(link, 'View your order') : `<p style="font-size:13px;color:#7a7f75">Use the link in your order confirmation email to see your order.</p>`}`);
  const text = [`Hi ${firstName(o)},`, '', plain, '', `Order ${o.orderNumber}:`, ...items, '', link ? `View your order: ${link}` : 'Use the link in your order confirmation email to see your order.', '', 'GreenLove Farms'].join('\n');
  return { subject: `${heading}: order ${o.orderNumber}`, html, text };
}

// ── Refunds ───────────────────────────────────────────────────────────────────

export function refundEmail(o: Order, r: OrderRefund, link: string | null): RenderedEmail {
  const card = o.payment.method?.brand ? `${o.payment.method.brand} ending ${o.payment.method.last4 ?? ''}` : 'your original payment method';
  const msg = `We’ve refunded ${money(r.amountCents)} to ${card}. Depending on your bank it can take 5–10 business days to show up.`;
  const html = emailLayout('Your refund is on its way', `<p>Hi ${escapeHtml(firstName(o))},</p><p>${escapeHtml(msg)}</p>
<p style="color:#5b6358;font-size:14px">Order ${escapeHtml(o.orderNumber)}</p>
${link ? emailButton(link, 'View your order') : ''}`);
  const text = [`Hi ${firstName(o)},`, '', msg.replace('’', "'"), '', `Order ${o.orderNumber}`, ...(link ? ['', `View your order: ${link}`] : []), '', 'GreenLove Farms'].join('\n');
  return { subject: `Refund for order ${o.orderNumber}`, html, text };
}
