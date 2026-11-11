// Generates the Postman collection + environments in this folder. Run: node postman/build-collection.mjs
// Request order is the automated test order (see run-tests.sh), so later requests reuse ids saved by earlier ones.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));

const NOAUTH = { type: 'noauth' };
const bearer = (token) => ({ type: 'bearer', bearer: [{ key: 'token', value: `{{${token}}}`, type: 'string' }] });
const ADMIN = bearer('adminIdToken');

// JSON.stringify can't emit an unquoted {{var}}, so numeric variables go through a placeholder.
const json = (obj) => ({
  mode: 'raw',
  raw: JSON.stringify(obj, null, 2).replace(/"__NUM:(\w+)__"/g, '{{$1}}'),
  options: { raw: { language: 'json' } },
});
const num = (name) => `__NUM:${name}__`;

// ── Script snippets ──
const status = (code) => `pm.test('status ${code}', () => pm.response.to.have.status(${code}));`;
const errorBody = `pm.test('error message', () => pm.expect(pm.response.json()).to.have.property('error'));`;
const set = (key, expr) => `pm.environment.set('${key}', ${expr});`;

// Requests that send emails or need a code from an inbox only run by hand.
const MANUAL = `if (pm.variables.get('automated') === 'true') pm.execution.skipRequest();`;
// Without admin credentials the run still covers the customer-facing routes.
const NEEDS_ADMIN = `if (!pm.variables.get('adminEmail')) pm.execution.skipRequest();`;
const NEEDS_TEST_PRODUCT = `if (!pm.variables.get('testProductCreated')) pm.execution.skipRequest();`;
// Cart and watchlist item tests need some ACTIVE product: the admin-created one, or any live one.
const NEEDS_PRODUCT = `if (!pm.variables.get('productId')) pm.execution.skipRequest();`;
// Nothing after a failed login can pass, so stop the run instead of reporting dozens of 401s.
const stopUnless200 = "if (pm.response.code !== 200) pm.execution.setNextRequest(null);";

function req(name, method, path, { body, query, auth, pre, tests, description } = {}) {
  const raw = `{{base_url}}${path}${query ? '?' + query.map((q) => `${q.key}=${q.value}`).join('&') : ''}`;
  const event = [];
  if (pre) event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: [].concat(pre) } });
  if (tests) event.push({ listen: 'test', script: { type: 'text/javascript', exec: tests } });
  return {
    name,
    request: {
      method,
      ...(auth ? { auth } : {}),
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      ...(body ? { body: json(body) } : {}),
      url: { raw, host: ['{{base_url}}'], path: path.split('/').filter(Boolean), ...(query ? { query } : {}) },
      ...(description ? { description } : {}),
    },
    ...(event.length ? { event } : {}),
  };
}

const q = (key, value, disabled = false, description) => ({ key, value, ...(disabled ? { disabled } : {}), ...(description ? { description } : {}) });
const folder = (name, item, extra = {}) => ({ name, item, ...extra });

// ── Fixtures ──
// Created ACTIVE so the cart and watchlist tests can use it; archived again in Teardown.
const testProduct = (status, variant) => ({
  name: 'Postman Test Soap {{runId}}',
  slug: 'postman-test-{{runId}}',
  description: 'Created by the automated Postman run. Safe to delete.',
  shortDescription: 'Postman test product.',
  searchTerms: ['postman', 'test bar'],
  label: { ingredients: 'Saponified olive oil, water', allergens: [] },
  storage: 'Keep dry.',
  badges: ['NEW'],
  category: 'postman-test',
  status,
  fulfillmentClass: 'STOCKED',
  fulfillmentProfile: { methods: ['SHIP', 'PICKUP'], perishable: false, handlingDays: 2 },
  regulatoryClass: 'COSMETIC',
  taxCategory: 'general',
  images: [],
  variants: [variant],
});
const newVariant = { sku: 'PM-{{runId}}', name: '4 oz bar', priceCents: 800, weightOz: 4, netWeight: '4 oz (113 g)', onHand: 25 };
const keptVariant = (priceCents) => ({ id: '{{variantId}}', sku: 'PM-{{runId}}', name: '4 oz bar', priceCents, weightOz: 4, netWeight: '4 oz (113 g)' });
const testCategory = (status) => ({ name: 'Postman Test', blurb: 'Created by the automated Postman run.', sortOrder: 999, status });

const saveAdminProduct = [
  'const p = pm.response.json();',
  set('productId', 'p.id'),
  set('productSlug', 'p.slug'),
  set('variantId', 'p.variants[0].id'),
  set('productVersion', 'p.version'),
];

const cartShape = [
  'const c = pm.response.json();',
  'c.lines = c.lines || [];',
  "pm.test('cart shape', () => { pm.expect(c.lines).to.be.an('array'); pm.expect(c.itemCount).to.be.a('number'); pm.expect(c.subtotalCents).to.be.a('number'); });",
];
const hasLine = (qty) => [
  ...cartShape,
  "const line = c.lines.find((l) => l.variantId === pm.environment.get('variantId'));",
  `pm.test('line has qty ${qty}', () => pm.expect(line && line.qty).to.eql(${qty}));`,
];
const noLine = [
  ...cartShape,
  "pm.test('line removed', () => pm.expect(c.lines.some((l) => l.variantId === pm.environment.get('variantId'))).to.be.false);",
];

// ── Auth ──
const auth = folder('Auth', [
  req('Health', 'GET', '/auth/health', { auth: NOAUTH, tests: [status(200)] }),
  req('Login', 'POST', '/auth/login', {
    auth: NOAUTH,
    body: { email: '{{email}}', password: '{{password}}' },
    description: 'Saves idToken (sent as the Bearer token), accessToken, refreshToken and expiresIn.',
    tests: [
      stopUnless200,
      status(200),
      'const r = pm.response.json();',
      "pm.test('returns tokens', () => { pm.expect(r.idToken).to.be.a('string'); pm.expect(r.refreshToken).to.be.a('string'); });",
      set('idToken', 'r.idToken'),
      set('accessToken', 'r.accessToken'),
      set('refreshToken', 'r.refreshToken'),
      set('expiresIn', 'r.expiresIn'),
    ],
  }),
  req('Login (wrong password)', 'POST', '/auth/login', {
    auth: NOAUTH,
    body: { email: '{{email}}', password: 'Wrong-Password-1' },
    tests: [status(401), errorBody],
  }),
  req('Refresh', 'POST', '/auth/refresh', {
    auth: NOAUTH,
    body: { refreshToken: '{{refreshToken}}' },
    tests: [
      status(200),
      'const r = pm.response.json();',
      "pm.test('returns idToken', () => pm.expect(r.idToken).to.be.a('string'));",
      set('idToken', 'r.idToken'),
    ],
  }),
  req('Get profile', 'GET', '/auth/me', {
    tests: [
      status(200),
      'const r = pm.response.json();',
      "pm.test('profile matches login', () => pm.expect(r.email).to.eql(pm.environment.get('email').toLowerCase()));",
      "pm.test('has groups', () => pm.expect(r.groups).to.be.an('array'));",
    ],
  }),
  req('Get profile (no token)', 'GET', '/auth/me', { auth: NOAUTH, tests: [status(401)] }),
  req('Update profile', 'PUT', '/auth/me', {
    body: {
      fullName: 'Postman Test Customer',
      phone: '5555550123',
      marketingEmail: false,
      sms: false,
      addresses: [{ label: 'Home', line1: '123 Farm Rd', city: 'Springfield', state: 'OR', zip: '97477', deliveryInstructions: 'Leave at gate' }],
    },
    description: 'Every field is optional; only the fields sent are changed.',
    tests: [
      status(200),
      'const r = pm.response.json();',
      "pm.test('saved', () => { pm.expect(r.fullName).to.eql('Postman Test Customer'); pm.expect(r.addresses).to.have.lengthOf(1); });",
    ],
  }),
  req('Update profile (bad phone)', 'PUT', '/auth/me', { body: { phone: '123' }, tests: [status(400), errorBody] }),
  folder('Addresses', [
    req('List addresses', 'GET', '/auth/me/addresses', {
      description: 'Default first. Each address has an id for editing.',
      tests: [
        status(200),
        'const r = pm.response.json();',
        "pm.test('one default, with ids', () => { pm.expect(r.items.filter((a) => a.isDefault)).to.have.lengthOf(1); r.items.forEach((a) => pm.expect(a.id).to.be.a('string')); });",
        set('homeAddressId', 'r.items[0].id'),
      ],
    }),
    req('Add address (as default)', 'POST', '/auth/me/addresses', {
      body: { label: 'Work', line1: '500 Main St', city: 'Houston', state: 'TX', zip: '77002', isDefault: true },
      tests: [status(201), 'const a = pm.response.json();', "pm.test('is default', () => pm.expect(a.isDefault).to.be.true);", set('addressId', 'a.id')],
    }),
    req('Add address (bad zip)', 'POST', '/auth/me/addresses', { body: { line1: '1 A St', city: 'Houston', state: 'TX', zip: '7700' }, tests: [status(400), errorBody] }),
    req('Edit address', 'PUT', '/auth/me/addresses/{{addressId}}', {
      body: { line2: 'Suite 200', deliveryInstructions: 'Front desk' },
      description: 'Partial: only the fields sent change.',
      tests: [status(200), 'const a = pm.response.json();', "pm.test('edited, rest kept', () => { pm.expect(a.line2).to.eql('Suite 200'); pm.expect(a.line1).to.eql('500 Main St'); });"],
    }),
    req('Make first address default', 'PUT', '/auth/me/addresses/{{homeAddressId}}', { body: { isDefault: true }, tests: [status(200), "pm.test('is default', () => pm.expect(pm.response.json().isDefault).to.be.true);"] }),
    req('List addresses (default moved)', 'GET', '/auth/me/addresses', {
      tests: [
        status(200),
        'const r = pm.response.json();',
        "pm.test('first is default, work is not', () => { pm.expect(r.items[0].id).to.eql(pm.environment.get('homeAddressId')); pm.expect(r.items.find((a) => a.id === pm.environment.get('addressId')).isDefault).to.be.false; });",
      ],
    }),
    req('Edit address (unknown id)', 'PUT', '/auth/me/addresses/000000000000000000000000', { body: { city: 'Katy' }, tests: [status(404), errorBody] }),
    req('Delete address', 'DELETE', '/auth/me/addresses/{{addressId}}', { tests: [status(204)] }),
    req('Delete address (again)', 'DELETE', '/auth/me/addresses/{{addressId}}', { tests: [status(404)] }),
  ]),
  req('Admin login', 'POST', '/auth/login', {
    auth: NOAUTH,
    pre: NEEDS_ADMIN,
    body: { email: '{{adminEmail}}', password: '{{adminPassword}}' },
    description: 'A Staff or Admins user. Saves adminIdToken, used by Catalog → Admin.',
    tests: [status(200), 'const r = pm.response.json();', set('adminIdToken', 'r.idToken')],
  }),
  folder('Manual (email codes)', [
    req('Sign up', 'POST', '/auth/signup', {
      auth: NOAUTH,
      pre: MANUAL,
      body: { email: '{{email}}', password: '{{password}}', fullName: 'Test Customer' },
      tests: [status(201)],
    }),
    req('Confirm sign up', 'POST', '/auth/confirm-signup', {
      auth: NOAUTH,
      pre: MANUAL,
      body: { email: '{{email}}', code: '123456' },
      description: 'Use the code emailed by Cognito.',
      tests: [status(200)],
    }),
    req('Resend code', 'POST', '/auth/resend-code', { auth: NOAUTH, pre: MANUAL, body: { email: '{{email}}' }, tests: [status(200)] }),
    req('Forgot password', 'POST', '/auth/forgot-password', { auth: NOAUTH, pre: MANUAL, body: { email: '{{email}}' }, tests: [status(200)] }),
    req('Confirm password', 'POST', '/auth/confirm-password', {
      auth: NOAUTH,
      pre: MANUAL,
      body: { email: '{{email}}', code: '123456', newPassword: '{{password}}' },
      tests: [status(200)],
    }),
    req('Admin: set role', 'POST', '/auth/admin/users/role', {
      auth: ADMIN,
      pre: MANUAL,
      body: { email: 'someone@example.com', role: 'STAFF' },
      description: "Admins only. role: CUSTOMER | STAFF | ADMIN. Takes effect on the target user's next sign-in or refresh.",
      tests: [status(200)],
    }),
  ], { description: 'Skipped in automated runs: these send emails, need a code from an inbox, or change real roles.' }),
]);

// ── Catalog ──
const catalog = folder('Catalog', [
  req('Health', 'GET', '/catalog/health', { auth: NOAUTH, tests: [status(200)] }),
  folder('Admin', [
    req('List products (no token)', 'GET', '/catalog/admin/products', { auth: NOAUTH, tests: [status(401)] }),
    req('List products (customer)', 'GET', '/catalog/admin/products', { auth: bearer('idToken'), tests: [status(403), errorBody] }),
    req('List products', 'GET', '/catalog/admin/products', {
      pre: NEEDS_ADMIN,
      query: [q('page', '1'), q('limit', '24'), q('status', 'DRAFT', true), q('category', 'soap', true), q('q', 'lavender', true, 'Matches name or SKU')],
      tests: [status(200), "pm.test('paged list', () => pm.expect(pm.response.json().items).to.be.an('array'));"],
    }),
    req('Create product', 'POST', '/catalog/admin/products', {
      pre: [NEEDS_ADMIN, "pm.environment.set('runId', Date.now().toString(36));"],
      body: testProduct('ACTIVE', newVariant),
      description: 'slug is derived from name when blank. Only STOCKED products can be ACTIVE for now.',
      tests: [
        status(201),
        ...saveAdminProduct,
        set('testProductCreated', "'true'"),
        "pm.test('stock set', () => pm.expect(p.variants[0].inventory.onHand).to.eql(25));",
      ],
    }),
    req('Create product (invalid)', 'POST', '/catalog/admin/products', {
      pre: NEEDS_ADMIN,
      body: { name: '', variants: [] },
      tests: [status(400), errorBody],
    }),
    req('Create product (active without label)', 'POST', '/catalog/admin/products', {
      pre: NEEDS_ADMIN,
      body: { ...testProduct('ACTIVE', { ...newVariant, sku: 'PM-NOLABEL-{{runId}}' }), slug: 'postman-nolabel-{{runId}}', label: null },
      description: 'COSMETIC, COTTAGE_FOOD and TCS products need label.ingredients before they can be ACTIVE.',
      tests: [status(400), "pm.test('label error', () => pm.expect(pm.response.json().details).to.have.property('label.ingredients'));"],
    }),
    req('Get product', 'GET', '/catalog/admin/products/{{productId}}', {
      pre: NEEDS_TEST_PRODUCT,
      tests: [status(200), "pm.test('same product', () => pm.expect(pm.response.json().id).to.eql(pm.environment.get('productId')));"],
    }),
    req('Update product', 'PUT', '/catalog/admin/products/{{productId}}', {
      pre: NEEDS_TEST_PRODUCT,
      body: { version: num('productVersion'), ...testProduct('ACTIVE', keptVariant(900)) },
      description: 'Full replacement. Send the version from the last read, and existing variant ids to keep their inventory.',
      tests: [status(200), ...saveAdminProduct, "pm.test('price changed', () => pm.expect(p.variants[0].priceCents).to.eql(900));"],
    }),
    req('Update product (stale version)', 'PUT', '/catalog/admin/products/{{productId}}', {
      pre: NEEDS_TEST_PRODUCT,
      body: { version: 0, ...testProduct('ACTIVE', keptVariant(900)) },
      tests: [status(409), errorBody],
    }),
    req('Adjust inventory', 'POST', '/catalog/admin/products/{{productId}}/inventory', {
      pre: NEEDS_TEST_PRODUCT,
      body: { variantId: '{{variantId}}', delta: 10, reason: 'RESTOCK', note: 'Postman run' },
      description: 'reason: RESTOCK | COUNT_CORRECTION | DAMAGED | MARKET_SALE | OTHER',
      tests: [status(200), ...saveAdminProduct, "pm.test('stock increased', () => pm.expect(p.variants[0].inventory.onHand).to.eql(35));"],
    }),
    req('Adjust inventory (oversell)', 'POST', '/catalog/admin/products/{{productId}}/inventory', {
      pre: NEEDS_TEST_PRODUCT,
      body: { variantId: '{{variantId}}', delta: -100000, reason: 'COUNT_CORRECTION' },
      tests: [status(409), errorBody],
    }),
    req('Save category', 'PUT', '/catalog/admin/categories/postman-test', {
      pre: NEEDS_ADMIN,
      body: testCategory('ACTIVE'),
      description: 'Creates or replaces the category with this slug. Set status HIDDEN to retire it.',
      tests: [status(200), "pm.test('saved', () => pm.expect(pm.response.json().slug).to.eql('postman-test'));", set('testCategoryCreated', "'true'")],
    }),
    req('Save category (invalid)', 'PUT', '/catalog/admin/categories/Bad_Slug', {
      pre: NEEDS_ADMIN,
      body: testCategory('ACTIVE'),
      tests: [status(400), errorBody],
    }),
    req('List categories', 'GET', '/catalog/admin/categories', {
      pre: NEEDS_ADMIN,
      tests: [status(200), "pm.test('list', () => pm.expect(pm.response.json().items).to.be.an('array'));"],
    }),
    req('Sign image upload', 'POST', '/catalog/admin/images/sign', {
      pre: NEEDS_ADMIN,
      description: 'Returns uploadUrl + signed fields for a direct browser upload to Cloudinary.',
      tests: [
        status(200),
        'const r = pm.response.json();',
        "pm.test('signed fields', () => { pm.expect(r.uploadUrl).to.include('cloudinary.com'); pm.expect(r.fields.signature).to.be.a('string'); });",
      ],
    }),
  ], { auth: ADMIN, description: 'Requires a Staff or Admins user — run Auth → Admin login first.' }),
  req('List products', 'GET', '/catalog/products', {
    auth: NOAUTH,
    query: [q('page', '1'), q('limit', '100'), q('category', 'soap', true), q('fulfillmentClass', 'STOCKED', true)],
    tests: [
      status(200),
      'const r = pm.response.json();',
      "pm.test('paged list', () => { pm.expect(r.items).to.be.an('array'); pm.expect(r.total).to.be.a('number'); });",
      '// Without the admin-created test product, fall back to a live product with stock for the cart and checkout tests.',
      "const live = r.items.map((p) => ({ p, v: p.variants.find((v) => v.available === null || v.available > 2) })).find((x) => x.v);",
      "if (!pm.environment.get('testProductCreated') && live) {",
      `  ${set('productId', 'live.p.id')}`,
      `  ${set('productSlug', 'live.p.slug')}`,
      `  ${set('variantId', 'live.v.id')}`,
      '}',
    ],
  }),
  req('List products (sorted, filtered)', 'GET', '/catalog/products', {
    auth: NOAUTH,
    query: [q('sort', 'price_asc', false, 'featured (default) | newest | price_asc | price_desc | relevance (needs q)'), q('methods', 'SHIP', false, 'Comma-separated: SHIP, LOCAL_DELIVERY, PICKUP'), q('minPrice', '0', false, 'Cents'), q('maxPrice', '100000', false, 'Cents'), q('inStock', 'true', true)],
    tests: [
      status(200),
      'const r = pm.response.json();',
      "pm.test('sorted by price', () => { const p = r.items.map((i) => i.priceFromCents); pm.expect(p).to.eql([...p].sort((a, b) => a - b)); });",
      "pm.test('all ship', () => r.items.forEach((i) => pm.expect(i.fulfillmentProfile.methods).to.include('SHIP')));",
      "pm.test('availability shape', () => r.items.forEach((i) => pm.expect(i.availability).to.have.property('status')));",
    ],
  }),
  req('Search products', 'GET', '/catalog/products', {
    auth: NOAUTH,
    query: [q('q', 'soap', false, 'Atlas Search: name, synonyms (searchTerms) and descriptions; forgives one typo')],
    tests: [status(200), "pm.test('paged list', () => pm.expect(pm.response.json().items).to.be.an('array'));", "pm.test('relevance sort', () => pm.expect(pm.response.json().sort).to.eql('relevance'));"],
  }),
  req('Suggest products', 'GET', '/catalog/products/suggest', {
    auth: NOAUTH,
    query: [q('q', 'so')],
    tests: [status(200), 'const r = pm.response.json();', "pm.test('shape', () => { pm.expect(r.products).to.be.an('array'); pm.expect(r.categories).to.be.an('array'); });"],
  }),
  req('Suggest products (too short)', 'GET', '/catalog/products/suggest', { auth: NOAUTH, query: [q('q', 's')], tests: [status(400), errorBody] }),
  req('List products (bad sort)', 'GET', '/catalog/products', { auth: NOAUTH, query: [q('sort', 'relevance')], tests: [status(400), errorBody] }),
  req('List products (bad filter)', 'GET', '/catalog/products', {
    auth: NOAUTH,
    query: [q('fulfillmentClass', 'NOPE')],
    tests: [status(400), errorBody],
  }),
  req('Get product by slug', 'GET', '/catalog/products/{{productSlug}}', { pre: NEEDS_PRODUCT,
    auth: NOAUTH,
    tests: [
      status(200),
      "pm.test('same product', () => pm.expect(pm.response.json().slug).to.eql(pm.environment.get('productSlug')));",
      "pm.test('no inventory leaked', () => pm.expect(JSON.stringify(pm.response.json())).to.not.include('onHand'));",
    ],
  }),
  req('Get product by slug (missing)', 'GET', '/catalog/products/no-such-product-postman', { auth: NOAUTH, tests: [status(404)] }),
  req('List categories', 'GET', '/catalog/categories', {
    auth: NOAUTH,
    tests: [
      status(200),
      'const r = pm.response.json();',
      "pm.test('list', () => pm.expect(r.items).to.be.an('array'));",
      "if (pm.environment.get('testCategoryCreated')) pm.test('test category counts its product', () => { const c = r.items.find((i) => i.slug === 'postman-test'); pm.expect(c && c.productCount).to.be.at.least(pm.environment.get('testProductCreated') ? 1 : 0); });",
    ],
  }),
]);

// ── Carts ──
const carts = folder('Carts', [
  req('Health', 'GET', '/carts/health', { auth: NOAUTH, tests: [status(200)] }),
  folder('Anonymous cart', [
    req('Create cart', 'POST', '/carts/new', {
      tests: [status(201), 'const c = pm.response.json();', "pm.test('has cartId', () => pm.expect(c.cartId).to.be.a('string'));", set('cartId', 'c.cartId')],
    }),
    req('Get cart', 'GET', '/carts/{{cartId}}', { tests: [status(200), ...cartShape] }),
    req('Get cart (unknown id)', 'GET', '/carts/00000000-0000-4000-8000-000000000000', { tests: [status(404)] }),
    req('Get cart (invalid id)', 'GET', '/carts/not-a-uuid', { tests: [status(400)] }),
    req('Set item', 'PUT', '/carts/{{cartId}}/items', { pre: NEEDS_PRODUCT,
      body: { productId: '{{productId}}', variantId: '{{variantId}}', qty: 2 },
      tests: [status(200), ...hasLine(2)],
    }),
    req('Set item (qty over limit)', 'PUT', '/carts/{{cartId}}/items', { pre: NEEDS_PRODUCT,
      body: { productId: '{{productId}}', variantId: '{{variantId}}', qty: 100 },
      tests: [status(400), errorBody],
    }),
    req('Set contact', 'PUT', '/carts/{{cartId}}/contact', {
      body: { email: '{{email}}', marketingEmail: false },
      tests: [status(200), ...cartShape],
    }),
    req('Record view', 'POST', '/carts/{{cartId}}/views', { pre: NEEDS_PRODUCT, body: { productId: '{{productId}}' }, tests: [status(204)] }),
    req('List views', 'GET', '/carts/{{cartId}}/views', { pre: NEEDS_PRODUCT,
      query: [q('limit', '12'), q('exclude', '', true, 'A product id to leave out, e.g. the one on screen')],
      tests: [status(200), "pm.test('viewed product listed', () => pm.expect(pm.response.json().items[0].product.id).to.eql(pm.environment.get('productId')));"],
    }),
    req('Remove item', 'DELETE', '/carts/{{cartId}}/items/{{variantId}}', { pre: NEEDS_PRODUCT, tests: [status(200), ...noLine] }),
    req('Set item (for merge)', 'PUT', '/carts/{{cartId}}/items', { pre: NEEDS_PRODUCT,
      body: { productId: '{{productId}}', variantId: '{{variantId}}', qty: 1 },
      tests: [status(200), ...hasLine(1)],
    }),
  ], { auth: NOAUTH }),
  folder('Signed-in cart', [
    req('Merge anonymous cart', 'POST', '/carts/me/cart/merge', {
      body: { cartId: '{{cartId}}' },
      description: "Call after login to fold the browser's anonymous cart into the account cart.",
      tests: [
        status(200),
        ...cartShape,
        "if (pm.environment.get('productId')) pm.test('merged line present', () => pm.expect(c.lines.some((l) => l.variantId === pm.environment.get('variantId'))).to.be.true);",
      ],
    }),
    req('List my views (moved at merge)', 'GET', '/carts/me/views', { pre: NEEDS_PRODUCT,
      description: "The anonymous cart's views move to the account when it merges.",
      tests: [status(200), "pm.test('viewed product carried over', () => pm.expect(pm.response.json().items.some((i) => i.product.id === pm.environment.get('productId'))).to.be.true);"],
    }),
    req('Get anonymous cart after merge', 'GET', '/carts/{{cartId}}', {
      auth: NOAUTH,
      description: 'A merged cart is no longer usable anonymously.',
      tests: ["pm.test('not active anymore', () => pm.expect(pm.response.code === 404 || pm.response.json().status !== 'ACTIVE').to.be.true);"],
    }),
    req('Get my cart', 'GET', '/carts/me/cart', { tests: [status(200), ...cartShape] }),
    req('Set item', 'PUT', '/carts/me/cart/items', { pre: NEEDS_PRODUCT,
      body: { productId: '{{productId}}', variantId: '{{variantId}}', qty: 3 },
      tests: [status(200), ...hasLine(3)],
    }),
    req('Remove item', 'DELETE', '/carts/me/cart/items/{{variantId}}', { pre: NEEDS_PRODUCT, tests: [status(200), ...noLine] }),
    req('Get my cart (no token)', 'GET', '/carts/me/cart', { auth: NOAUTH, tests: [status(401)] }),
    req('Record view', 'POST', '/carts/me/views', { pre: NEEDS_PRODUCT, body: { productId: '{{productId}}' }, tests: [status(204)] }),
  ]),
  folder('Watchlist', [
    req('Add to watchlist', 'PUT', '/carts/me/watchlist/{{productId}}', { pre: NEEDS_PRODUCT, tests: [status(204)] }),
    req('List watchlist', 'GET', '/carts/me/watchlist', { pre: NEEDS_PRODUCT,
      tests: [
        status(200),
        "pm.test('contains product', () => pm.expect(pm.response.json().items.some((i) => i.product.id === pm.environment.get('productId'))).to.be.true);",
      ],
    }),
    req('Remove from watchlist', 'DELETE', '/carts/me/watchlist/{{productId}}', { pre: NEEDS_PRODUCT, tests: [status(204)] }),
    req('List watchlist (after remove)', 'GET', '/carts/me/watchlist', { pre: NEEDS_PRODUCT,
      tests: [
        status(200),
        "pm.test('product gone', () => pm.expect(pm.response.json().items.some((i) => i.product.id === pm.environment.get('productId'))).to.be.false);",
      ],
    }),
  ]),
]);

// ── Checkout ──
// Uses the product from Catalog (or Carts' fallback). Payments use Stripe test cards, confirmed with the
// publishable key exactly as the website's Payment Element does it.
const pickMethod = [
  "const opts = (q.groups[0] || {}).methodOptions || [];",
  "pm.environment.set('checkoutMethod', opts.includes('PICKUP') ? 'PICKUP' : opts[0] || 'PICKUP');",
];
const checkoutBody = (cartId) => ({
  ...(cartId ? { cartId } : {}),
  contact: { email: '{{email}}', fullName: 'Postman Tester', phone: '713-555-0100' },
  address: { line1: '10000 Jones Rd', city: 'Houston', state: 'TX', zip: '77070' },
  groups: [{ fulfillmentClass: 'STOCKED', method: '{{checkoutMethod}}', pickupLocation: 'HOUSTON' }],
});
const payable = [
  "pm.test('payable', () => pm.expect(q.payable, JSON.stringify(q.issues)).to.be.true);",
  "pm.test('total = subtotal + fees + tax', () => { const t = q.totals; pm.expect(t.totalCents).to.eql(t.subtotalCents - t.discountCents + t.deliveryCents + t.shippingCents + t.taxCents); });",
];
const NEEDS_PAYMENT = "if (!pm.variables.get('paymentIntentId')) pm.execution.skipRequest();";
const stripeConfirm = (name, card, tests) => ({
  name,
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: [NEEDS_PAYMENT, "if (!pm.variables.get('stripePublishableKey')) pm.execution.skipRequest();"] } },
    { listen: 'test', script: { type: 'text/javascript', exec: tests } },
  ],
  request: {
    method: 'POST',
    auth: { type: 'basic', basic: [{ key: 'username', value: '{{stripePublishableKey}}', type: 'string' }, { key: 'password', value: '', type: 'string' }] },
    header: [],
    body: { mode: 'urlencoded', urlencoded: [
      { key: 'client_secret', value: '{{clientSecret}}' },
      { key: 'payment_method', value: card },
      { key: 'return_url', value: 'http://localhost:3000/checkout/confirmation' },
    ] },
    url: { raw: 'https://api.stripe.com/v1/payment_intents/{{paymentIntentId}}/confirm', protocol: 'https', host: ['api', 'stripe', 'com'], path: ['v1', 'payment_intents', '{{paymentIntentId}}', 'confirm'] },
    description: `Stripe test card ${card}. Sandbox only.`,
  },
});

const checkout = folder('Checkout', [
  req('Health', 'GET', '/checkout/health', { auth: NOAUTH, tests: [status(200)] }),
  folder('Guest checkout', [
    req('Create cart', 'POST', '/carts/new', {
      tests: [status(201), set('checkoutCartId', 'pm.response.json().cartId'), "pm.environment.unset('paymentIntentId');", "pm.environment.unset('statusTries');"],
    }),
    req('Add item', 'PUT', '/carts/{{checkoutCartId}}/items', { pre: NEEDS_PRODUCT,
      body: { productId: '{{productId}}', variantId: '{{variantId}}', qty: 1 },
      tests: [status(200)],
    }),
    req('Quote (nothing chosen yet)', 'POST', '/checkout/quote', { pre: NEEDS_PRODUCT,
      body: { cartId: '{{checkoutCartId}}' },
      description: 'Call on every checkout change. Problems come back as issues with HTTP 200.',
      tests: [
        status(200), 'const q = pm.response.json();',
        "pm.test('not payable yet', () => pm.expect(q.payable).to.be.false);",
        "pm.test('asks for a method and contact', () => pm.expect(q.issues.map((i) => i.code)).to.include.members(['METHOD_REQUIRED', 'CONTACT_REQUIRED']));",
        "pm.test('offers methods', () => pm.expect(q.groups[0].methodOptions).to.be.an('array').that.is.not.empty);",
        ...pickMethod,
      ],
    }),
    req('Quote (invalid details)', 'POST', '/checkout/quote', {
      body: { cartId: '{{checkoutCartId}}', address: { line1: '', state: 'ZZ', zip: '1' }, groups: [{ fulfillmentClass: 'STOCKED', method: 'BOAT' }] },
      tests: [status(400), "pm.test('field errors', () => pm.expect(pm.response.json().details).to.have.property('address.zip'));"],
    }),
    req('Quote (local delivery, outside area)', 'POST', '/checkout/quote', { pre: NEEDS_PRODUCT,
      body: { cartId: '{{checkoutCartId}}', address: { line1: '1 Main St', city: 'Dallas', state: 'TX', zip: '75201' }, groups: [{ fulfillmentClass: 'STOCKED', method: 'LOCAL_DELIVERY' }] },
      tests: [status(200), 'const q = pm.response.json();', "pm.test('not payable', () => pm.expect(q.payable).to.be.false);"],
    }),
    req('Quote', 'POST', '/checkout/quote', { pre: NEEDS_PRODUCT,
      body: checkoutBody('{{checkoutCartId}}'),
      tests: [status(200), 'const q = pm.response.json();', ...payable, set('quoteId', 'q.quoteId'), set('quoteTotal', 'q.totals.totalCents')],
    }),
    req('Pay (no cartId)', 'POST', '/checkout/pay', { body: { quoteId: '{{quoteId}}' }, tests: [status(400)] }),
    req('Pay (someone else’s cart)', 'POST', '/checkout/pay', {
      body: { cartId: '00000000-0000-4000-8000-000000000000', quoteId: '{{quoteId}}' }, tests: [status(404)],
    }),
    req('Pay', 'POST', '/checkout/pay', { pre: NEEDS_PRODUCT,
      body: { cartId: '{{checkoutCartId}}', quoteId: '{{quoteId}}' },
      description: 'Holds the stock and returns the PaymentIntent client secret for stripe.confirmPayment().',
      tests: [
        status(200), 'const d = pm.response.json();',
        "pm.test('client secret', () => pm.expect(d.clientSecret).to.match(/^pi_.+_secret_/));",
        "pm.test('amount = quote total', () => pm.expect(d.amountCents).to.eql(Number(pm.environment.get('quoteTotal'))));",
        set('paymentIntentId', 'd.paymentIntentId'), set('clientSecret', 'd.clientSecret'),
      ],
    }),
    req('Pay again (same payment)', 'POST', '/checkout/pay', { pre: NEEDS_PAYMENT,
      body: { cartId: '{{checkoutCartId}}', quoteId: '{{quoteId}}' },
      tests: [status(200), "pm.test('same PaymentIntent', () => pm.expect(pm.response.json().paymentIntentId).to.eql(pm.environment.get('paymentIntentId')));"],
    }),
    stripeConfirm('Stripe: declined card', 'pm_card_chargeDeclined', [
      "pm.test('declined', () => pm.expect(pm.response.json().error.code).to.eql('card_declined'));",
    ]),
    stripeConfirm('Stripe: pay with test Visa', 'pm_card_visa', [
      "pm.test('succeeded', () => pm.expect(pm.response.json().status).to.eql('succeeded'));",
    ]),
    req('Payment status (wait for order)', 'GET', '/checkout/status', {
      query: [q('paymentIntent', '{{paymentIntentId}}'), q('clientSecret', '{{clientSecret}}')],
      pre: [NEEDS_PAYMENT, "if (Number(pm.environment.get('statusTries') || 0) > 0) setTimeout(() => {}, 1500);"],
      description: 'The confirmation page polls this until the webhook has created the order.',
      tests: [
        status(200), 'const d = pm.response.json();',
        "const tries = Number(pm.environment.get('statusTries') || 0);",
        "if (d.status === 'PROCESSING' && tries < 12) { pm.environment.set('statusTries', tries + 1); pm.execution.setNextRequest(pm.info.requestName); } else {",
        "  pm.test('paid', () => pm.expect(d.status).to.eql('PAID'));",
        "  pm.test('order number', () => pm.expect(d.order.orderNumber).to.match(/^GLF-\\d{4}-\\d{6}$/));",
        "  pm.test('order total = amount paid', () => pm.expect(d.order.totals.totalCents).to.eql(Number(pm.environment.get('quoteTotal'))));",
        "  pm.environment.unset('statusTries');",
        "}",
      ],
    }),
    req('Payment status (wrong secret)', 'GET', '/checkout/status', { pre: NEEDS_PAYMENT,
      query: [q('paymentIntent', '{{paymentIntentId}}'), q('clientSecret', '{{paymentIntentId}}_secret_wrong')],
      tests: [status(404)],
    }),
    req('Pay after paid', 'POST', '/checkout/pay', { pre: NEEDS_PAYMENT,
      body: { cartId: '{{checkoutCartId}}', quoteId: '{{quoteId}}' },
      description: 'The paid cart is closed, so the guest cart is no longer found.',
      tests: ["pm.test('refused', () => pm.expect(pm.response.code).to.be.oneOf([404, 409]));"],
    }),
  ], { auth: NOAUTH }),
  folder('Signed-in checkout', [
    req('Add item to my cart', 'PUT', '/carts/me/cart/items', { pre: NEEDS_PRODUCT,
      body: { productId: '{{productId}}', variantId: '{{variantId}}', qty: 1 }, tests: [status(200)],
    }),
    req('Quote', 'POST', '/checkout/me/quote', { pre: NEEDS_PRODUCT,
      body: { address: checkoutBody().address, groups: checkoutBody().groups },
      description: 'Contact comes from the account (email is always the verified account email).',
      tests: [status(200), 'const q = pm.response.json();', ...payable,
        "pm.test('account email used', () => pm.expect(q.contact.email).to.eql(String(pm.environment.get('email')).toLowerCase()));",
        set('meQuoteId', 'q.quoteId')],
    }),
    req('Pay', 'POST', '/checkout/me/pay', { pre: NEEDS_PRODUCT,
      body: { quoteId: '{{meQuoteId}}' },
      description: 'Left unpaid on purpose: the sweep releases the held stock after 30 minutes.',
      tests: [status(200), "pm.test('client secret', () => pm.expect(pm.response.json().clientSecret).to.match(/^pi_.+_secret_/));"],
    }),
    req('Pay (guest quote with a token)', 'POST', '/checkout/me/pay', { pre: NEEDS_PRODUCT,
      body: { quoteId: '{{quoteId}}' }, tests: [status(404)],
    }),
    req('Quote (no token)', 'POST', '/checkout/me/quote', { auth: NOAUTH, body: {}, tests: [status(401)] }),
  ]),
]);

// ── Teardown ──
const teardown = folder('Teardown', [
  // Checkout changes the product's stock, which bumps its version: read the current one first.
  req('Get test product (current version)', 'GET', '/catalog/admin/products/{{productId}}', {
    auth: ADMIN,
    pre: NEEDS_TEST_PRODUCT,
    tests: [status(200), 'const p = pm.response.json();', set('productVersion', 'p.version')],
  }),
  req('Archive test product', 'PUT', '/catalog/admin/products/{{productId}}', {
    auth: ADMIN,
    pre: NEEDS_TEST_PRODUCT,
    body: { version: num('productVersion'), ...testProduct('ARCHIVED', keptVariant(900)) },
    tests: [status(200), "pm.test('archived', () => pm.expect(pm.response.json().status).to.eql('ARCHIVED'));", "pm.environment.unset('testProductCreated');"],
  }),
  req('Hide test category', 'PUT', '/catalog/admin/categories/postman-test', {
    auth: ADMIN,
    pre: "if (!pm.variables.get('testCategoryCreated')) pm.execution.skipRequest();",
    body: testCategory('HIDDEN'),
    tests: [status(200), "pm.environment.unset('testCategoryCreated');"],
  }),
], { description: 'Archives the product and hides the category created in Catalog → Admin so they leave the storefront.' });

// Refuse to write to prod during automated runs; reads are fine.
const prodGuard = [
  "const isProd = !String(pm.variables.get('base_url')).includes('api-dev.');",
  "if (pm.variables.get('automated') === 'true' && isProd && pm.request.method !== 'GET') pm.execution.skipRequest();",
];
const commonTests = [
  "pm.test('no server error', () => pm.expect(pm.response.code).to.be.below(500));",
  "pm.test('responds within 5s', () => pm.expect(pm.response.responseTime).to.be.below(5000));",
];

const collection = {
  info: {
    name: 'GreenLove Farms',
    description: [
      'Auth, catalog, carts and checkout stacks.',
      '',
      'Run Auth → Login first; it stores idToken, which signed-in requests send as a Bearer token. Catalog → Admin uses adminIdToken from Auth → Admin login.',
      '',
      'Automated run: postman/run-tests.sh (Newman), or the Collection Runner with automated=true. Requests run in order and pass ids along; "Manual" requests are skipped.',
      '',
      'Generated by postman/build-collection.mjs — edit that file, not this collection, or changes will be overwritten on the next push.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: bearer('idToken'),
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: prodGuard } },
    { listen: 'test', script: { type: 'text/javascript', exec: commonTests } },
  ],
  item: [auth, catalog, carts, checkout, teardown],
};

const env = (name, host) => ({
  name,
  values: [
    { key: 'base_url', value: `https://${host}`, type: 'default', enabled: true },
    { key: 'email', value: '', type: 'default', enabled: true },
    { key: 'password', value: '', type: 'secret', enabled: true },
    { key: 'adminEmail', value: '', type: 'default', enabled: true },
    { key: 'adminPassword', value: '', type: 'secret', enabled: true },
    { key: 'stripePublishableKey', value: '', type: 'default', enabled: true, description: 'pk_test_… for the sandbox; lets the Checkout folder pay with Stripe test cards' },
    ...['idToken', 'accessToken', 'refreshToken', 'expiresIn', 'adminIdToken', 'cartId', 'productId', 'productSlug', 'variantId', 'productVersion', 'checkoutCartId', 'checkoutMethod', 'quoteId', 'quoteTotal', 'meQuoteId', 'paymentIntentId', 'clientSecret'].map((key) => ({
      key,
      value: '',
      type: key.endsWith('Token') || key === 'clientSecret' ? 'secret' : 'default',
      enabled: true,
    })),
  ],
});

const write = (file, data) => writeFileSync(join(out, file), JSON.stringify(data, null, 2) + '\n');
write('greenlove-farms.postman_collection.json', collection);
write('dev.postman_environment.json', env('GreenLove Farms Dev', 'api-dev.greenlove-farms.com'));
write('prod.postman_environment.json', env('GreenLove Farms Production', 'api.greenlove-farms.com'));
console.log('wrote collection + environments to', out);
