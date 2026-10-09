import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from 'nodemailer';

const scrypt = promisify(scryptCallback);
const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataDirectory = resolve(process.env.DATA_DIRECTORY || resolve(root, 'data'));
const uploadDirectory = resolve(dataDirectory, 'uploads');
const menuCategories = ['Dumplings', 'Noodles', 'Sauces', 'Tteokpokki', 'Beverages'];
const dumplingStyles = ['Steamed', 'Pan-fried', 'Crispy skirt'];
mkdirSync(uploadDirectory, { recursive: true });

const jwtSecretPath = resolve(dataDirectory, 'jwt-secret');
if (!process.env.JWT_SECRET && !existsSync(jwtSecretPath)) {
  writeFileSync(jwtSecretPath, randomBytes(48), { mode: 0o600, flag: 'wx' });
}
const jwtSecret = process.env.JWT_SECRET || readFileSync(jwtSecretPath);
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');

const database = new DatabaseSync(resolve(dataDirectory, 'orders.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('customer', 'admin')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL REFERENCES categories(name) ON UPDATE CASCADE ON DELETE CASCADE,
    price INTEGER NOT NULL CHECK (price >= 0),
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    stock INTEGER NOT NULL DEFAULT -1,
    sold_out INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL,
    payment TEXT NOT NULL CHECK (payment IN ('Cash on delivery', 'InstaPay')),
    subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
    status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled')),
    notification_status TEXT NOT NULL DEFAULT 'Inbox',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    line_total INTEGER NOT NULL CHECK (line_total >= 0),
    style TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
`);

ensureOrderItemStyleColumn();
ensureOrderEmailColumn();
ensureMenuItemStockColumns();
migrateMenuCategories();
seedMenu();
await bootstrapAdmin();

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  setCommonHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      if (await handleApi(request, response, url)) return;
      json(response, 404, { error: 'Not found.' });
      return;
    }
    serveStatic(url.pathname, response);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error(error);
    json(response, status, { error: status === 500 ? 'The request could not be processed.' : error.message });
  }
});

async function handleApi(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(request);
    const { email, password } = validateCredentials(body, true);
    const user = await createUser(email, password, 'customer');
    json(response, 201, { token: createToken(user), user: publicUser(user) });
    return true;
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(request);
    const { email, password } = validateCredentials(body, false);
    const user = database.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    const valid = user ? await verifyPassword(password, user.password_salt, user.password_hash) : await verifyPassword(password, 'invalid-salt', '0'.repeat(128));
    if (!user || !valid) throw httpError(401, 'Email or password is incorrect.');
    json(response, 200, { token: createToken(user), user: publicUser(user) });
    return true;
  }
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = authenticate(request);
    json(response, 200, { user: publicUser(user) });
    return true;
  }
  if (pathname === '/api/menu' && method === 'GET') {
    json(response, 200, { categories: listCategories(), items: listMenuItems() });
    return true;
  }
  if (pathname === '/api/offers' && method === 'GET') {
    const includeInactive = url.searchParams.get('all') === 'true';
    if (includeInactive) verifyAdmin(request);
    const offers = includeInactive
      ? database.prepare('SELECT id, title, description, discount_percent AS discountPercent, active FROM offers ORDER BY title').all()
      : database.prepare('SELECT id, title, description, discount_percent AS discountPercent, active FROM offers WHERE active = 1 ORDER BY title').all();
    json(response, 200, { offers });
    return true;
  }
  if (pathname === '/api/hours' && method === 'GET') {
    json(response, 200, { hours: getWorkingHours() });
    return true;
  }
  if (pathname === '/api/hours' && method === 'PUT') {
    verifyAdmin(request);
    const hours = validateWorkingHours(await readBody(request));
    database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('workingHours', JSON.stringify(hours));
    json(response, 200, { hours });
    return true;
  }
  if (pathname === '/api/uploads' && method === 'POST') {
    verifyAdmin(request);
    const body = await readBody(request, 3_600_000);
    const image = saveUploadedImage(body.dataUrl);
    json(response, 201, { image });
    return true;
  }

  if (pathname === '/api/orders' && method === 'POST') {
    assertWithinWorkingHours();
    const order = validateOrder(await readBody(request));
    const id = `DL-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const createdAt = new Date().toISOString();
    const insertOrder = database.prepare('INSERT INTO orders (id, customer, phone, email, address, payment, subtotal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertItem = database.prepare('INSERT INTO order_items (order_id, name, category, quantity, unit_price, line_total, style) VALUES (?, ?, ?, ?, ?, ?, ?)');
    database.exec('BEGIN IMMEDIATE');
    try {
      insertOrder.run(id, order.customer, order.phone, order.email, order.address, order.payment, order.subtotal, createdAt);
      for (const item of order.items) {
        insertItem.run(id, item.name, item.category, item.quantity, item.unitPrice, item.lineTotal, item.style);
        database.prepare('UPDATE menu_items SET stock = MAX(stock - ?, 0), sold_out = CASE WHEN stock - ? <= 0 THEN 1 ELSE sold_out END WHERE id = ? AND stock >= 0').run(item.quantity, item.quantity, item.id);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const savedOrder = getOrder(id);
    notifyRestaurant(savedOrder).catch(error => console.error('Order notification failed:', error.message));
    json(response, 201, { order: savedOrder });
    return true;
  }

  if (pathname === '/api/orders' && method === 'GET') {
    verifyAdmin(request);
    json(response, 200, { orders: listOrders() });
    return true;
  }
  if (pathname === '/api/orders.csv' && method === 'GET') {
    verifyAdmin(request);
    const month = url.searchParams.get('month');
    let filtered = listOrders();
    let filenameSuffix = '';
    if (month) {
      const match = month.match(/^(\d{4})-(\d{2})$/);
      if (!match) throw httpError(400, 'Choose a valid month in YYYY-MM format.');
      const monthStart = new Date(`${match[1]}-${match[2]}-01T00:00:00.000Z`);
      const monthEnd = new Date(monthStart.getTime());
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      const startIso = monthStart.toISOString();
      const endIso = monthEnd.toISOString();
      filtered = filtered.filter(order => order.createdAt >= startIso && order.createdAt < endIso);
      filenameSuffix = `-${month}`;
    }
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="dumpling-lab-orders${filenameSuffix}.csv"`,
      'Cache-Control': 'no-store'
    }).end(ordersCSV(filtered));
    return true;
  }

  const orderStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (orderStatusMatch && method === 'PATCH') {
    verifyAdmin(request);
    const { status } = await readBody(request);
    const allowed = ['New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled'];
    if (!allowed.includes(status)) throw httpError(400, 'Choose a valid order status.');
    const id = decodeURIComponent(orderStatusMatch[1]);
    const result = database.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    if (!result.changes) throw httpError(404, 'Order not found.');
    json(response, 200, { order: getOrder(id) });
    return true;
  }

  if (pathname === '/api/categories' && method === 'POST') {
    verifyAdmin(request);
    const { name } = validateCategory(await readBody(request));
    try { database.prepare('INSERT INTO categories (name) VALUES (?)').run(name); }
    catch (error) {
      if (String(error.message).includes('UNIQUE')) throw httpError(409, 'That category already exists.');
      throw error;
    }
    json(response, 201, { categories: listCategories() });
    return true;
  }
  const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (categoryMatch && method === 'DELETE') {
    verifyAdmin(request);
    throw httpError(400, 'The menu categories are fixed: Dumplings, Noodles, Sauces, Tteokpokki, and Beverages.');
  }

  if (pathname === '/api/menu' && method === 'POST') {
    verifyAdmin(request);
    const item = validateMenuItem(await readBody(request));
    try {
      database.prepare('INSERT INTO menu_items (id, name, category, price, description, image, tag, stock, sold_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(item.id, item.name, item.category, item.price, item.description, item.image, item.tag, item.stock, item.soldOut ? 1 : 0);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw httpError(409, 'That menu item ID already exists.');
      throw error;
    }
    json(response, 201, { item: getMenuItem(item.id) });
    return true;
  }
  const menuItemMatch = pathname.match(/^\/api\/menu\/([^/]+)$/);
  if (menuItemMatch && (method === 'PUT' || method === 'DELETE')) {
    verifyAdmin(request);
    const id = decodeURIComponent(menuItemMatch[1]);
    if (method === 'DELETE') {
      const result = database.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
      if (!result.changes) throw httpError(404, 'Menu item not found.');
      json(response, 200, { ok: true });
      return true;
    }
    const item = validateMenuItem(await readBody(request), id);
    const result = database.prepare('UPDATE menu_items SET name = ?, category = ?, price = ?, description = ?, image = ?, tag = ?, stock = ?, sold_out = ? WHERE id = ?').run(item.name, item.category, item.price, item.description, item.image, item.tag, item.stock, item.soldOut ? 1 : 0, id);
    if (!result.changes) throw httpError(404, 'Menu item not found.');
    json(response, 200, { item: getMenuItem(id) });
    return true;
  }

  if (pathname === '/api/offers' && method === 'POST') {
    verifyAdmin(request);
    const offer = validateOffer(await readBody(request));
    try {
      database.prepare('INSERT INTO offers (id, title, description, discount_percent, active) VALUES (?, ?, ?, ?, ?)').run(offer.id, offer.title, offer.description, offer.discountPercent, Number(offer.active));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw httpError(409, 'That offer ID already exists.');
      throw error;
    }
    json(response, 201, { offer: getOffer(offer.id) });
    return true;
  }
  const offerMatch = pathname.match(/^\/api\/offers\/([^/]+)$/);
  if (offerMatch && (method === 'PUT' || method === 'DELETE')) {
    verifyAdmin(request);
    const id = decodeURIComponent(offerMatch[1]);
    if (method === 'DELETE') {
      const result = database.prepare('DELETE FROM offers WHERE id = ?').run(id);
      if (!result.changes) throw httpError(404, 'Offer not found.');
      json(response, 200, { ok: true });
      return true;
    }
    const offer = validateOffer(await readBody(request), id);
    const result = database.prepare('UPDATE offers SET title = ?, description = ?, discount_percent = ?, active = ? WHERE id = ?').run(offer.title, offer.description, offer.discountPercent, Number(offer.active), id);
    if (!result.changes) throw httpError(404, 'Offer not found.');
    json(response, 200, { offer: getOffer(id) });
    return true;
  }
  return false;
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function setCommonHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function createToken(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: user.id, email: user.email, role: user.role, iat: issuedAt, exp: issuedAt + 8 * 60 * 60 }));
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function authenticate(request) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw httpError(401, 'Sign in to continue.');
  const parts = token.split('.');
  if (parts.length !== 3) throw httpError(401, 'Your session is invalid. Please sign in again.');
  const expected = createHmac('sha256', jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
  let supplied;
  let header;
  let claims;
  try {
    supplied = Buffer.from(parts[2], 'base64url');
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw httpError(401, 'Your session is invalid. Please sign in again.');
  }
  if (!header || typeof header !== 'object' || header.alg !== 'HS256' || !claims || typeof claims !== 'object' || typeof claims.sub !== 'string' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError(401, 'Your session is invalid or has expired. Please sign in again.');
  }
  const user = database.prepare('SELECT id, email, role FROM users WHERE id = ?').get(claims.sub);
  if (!user || user.role !== claims.role) throw httpError(401, 'Your account session is no longer valid.');
  return user;
}

function verifyAdmin(request) {
  const user = authenticate(request);
  request.user = user;
  if (user.role !== 'admin') throw httpError(403, 'Administrator access required.');
  return user;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

function validateCredentials(body, signingUp) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw httpError(400, 'Enter a valid email address.');
  if (signingUp && (password.length < 12 || password.length > 128)) throw httpError(400, 'Passwords must be 12 to 128 characters long.');
  if (!signingUp && (!password || password.length > 128)) throw httpError(400, 'Enter your password.');
  return { email, password };
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}

async function verifyPassword(password, salt, expectedHex) {
  const { hash } = await hashPassword(password, salt);
  const supplied = Buffer.from(hash, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function createUser(email, password, role) {
  const { salt, hash } = await hashPassword(password);
  const user = { id: randomBytes(16).toString('hex'), email, role };
  try {
    database.prepare('INSERT INTO users (id, email, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, email, hash, salt, role, new Date().toISOString());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw httpError(409, 'An account with that email already exists.');
    throw error;
  }
  return user;
}

async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email && !password) {
    console.warn('No admin account configured. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to provision one.');
    return;
  }
  if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 128) {
    throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of 12–128 characters.');
  }
  const existing = database.prepare('SELECT id, role FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (existing) {
    if (existing.role !== 'admin') throw new Error('The bootstrap email belongs to a customer account; use a different email.');
    return;
  }
  await createUser(email, password, 'admin');
  console.log(`Provisioned the initial administrator account for ${email}.`);
}

function ensureOrderItemStyleColumn() {
  const columns = database.prepare('PRAGMA table_info(order_items)').all();
  if (!columns.some(column => column.name === 'style')) {
    database.exec("ALTER TABLE order_items ADD COLUMN style TEXT NOT NULL DEFAULT ''");
  }
}

function ensureOrderEmailColumn() {
  const columns = database.prepare('PRAGMA table_info(orders)').all();
  if (!columns.some(column => column.name === 'email')) {
    database.exec("ALTER TABLE orders ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  }
}

function ensureMenuItemStockColumns() {
  const columns = database.prepare('PRAGMA table_info(menu_items)').all();
  if (!columns.some(column => column.name === 'stock')) {
    database.exec('ALTER TABLE menu_items ADD COLUMN stock INTEGER NOT NULL DEFAULT -1');
  }
  if (!columns.some(column => column.name === 'sold_out')) {
    database.exec('ALTER TABLE menu_items ADD COLUMN sold_out INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateMenuCategories() {
  database.exec('BEGIN IMMEDIATE');
  try {
    const insertCategory = database.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
    for (const category of menuCategories) insertCategory.run(category);
    database.exec(`
      UPDATE menu_items
      SET category = CASE
        WHEN lower(category) IN ('steamed', 'pan-fried', 'dumplings') THEN 'Dumplings'
        WHEN lower(category) LIKE '%noodle%' THEN 'Noodles'
        WHEN lower(category) LIKE '%beverage%' OR lower(category) LIKE '%drink%' THEN 'Beverages'
        WHEN lower(category) LIKE '%sauce%' THEN 'Sauces'
        WHEN lower(category) LIKE '%extra%' AND lower(name) LIKE '%dipping%' THEN 'Sauces'
        WHEN lower(name) LIKE '%dipping%' THEN 'Sauces'
        ELSE 'Dumplings'
      END
    `);
    database.exec("DELETE FROM categories WHERE name NOT IN ('Dumplings', 'Noodles', 'Sauces', 'Tteokpokki', 'Beverages')");
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function seedMenu() {
  const insertCategory = database.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  for (const category of menuCategories) insertCategory.run(category);
  if (database.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count) return;
  const items = [
    ['item-1', 'Ginger cloud', 'Dumplings', 185, 'Chicken, fresh ginger, and a little spring onion tucked into soft, silky wrappers.', 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=900&q=85', 'HOUSE FAVOURITE'],
    ['item-2', 'Golden crunch', 'Dumplings', 210, 'Crispy-bottomed parcels, juicy chicken, and sesame soy for dipping.', 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', 'CRISPY LITTLE THING'],
    ['item-3', 'Mushroom moon', 'Dumplings', 195, 'Earthy shiitake, cabbage, and garlic chives. A lovely little plant-based parcel.', 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=85', 'PLANT-BASED'],
    ['item-4', 'Chilli oil crush', 'Dumplings', 220, 'Pork, a slow-building chilli warmth, and a crackly golden skirt.', 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', 'A LITTLE HEAT'],
    ['item-5', 'The dipping trio', 'Sauces', 75, 'House soy, ginger vinegar, and the chilli oil that started it all.', 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?auto=format&fit=crop&w=900&q=85', 'THREE IS THE MAGIC NUMBER'],
    ['item-6', 'Sesame clouds', 'Dumplings', 125, 'Warm, pillowy sesame buns with a molten sweet black sesame centre.', 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=900&q=85', 'SOMETHING SWEET']
  ];
  database.exec('BEGIN IMMEDIATE');
  try {
    const insertItem = database.prepare('INSERT INTO menu_items (id, name, category, price, description, image, tag, stock, sold_out) VALUES (?, ?, ?, ?, ?, ?, ?, -1, 0)');
    for (const item of items) insertItem.run(...item);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function validateCategory(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const canonicalName = menuCategories.find(category => category.toLowerCase() === name.toLowerCase());
  if (!canonicalName) {
    throw httpError(400, 'Choose one of the fixed menu categories: Dumplings, Noodles, Sauces, Tteokpokki, or Beverages.');
  }
  return { name: canonicalName };
}

function validateMenuItem(body, existingId = null) {
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const suppliedCategory = clean(body.category, 35);
  const category = menuCategories.find(entry => entry.toLowerCase() === suppliedCategory.toLowerCase());
  const item = {
    id: existingId || (typeof body.id === 'string' && /^[\w-]{1,80}$/.test(body.id) ? body.id : ''),
    name: clean(body.name, 60),
    category: category || '',
    price: Number(body.price),
    description: clean(body.description, 180),
    image: clean(body.image, 2_000),
    tag: clean(body.tag, 50),
    stock: body.stock === null || body.stock === undefined || body.stock === '' ? -1 : Number(body.stock),
    soldOut: Boolean(body.soldOut)
  };
  if (!item.id || !item.name || !item.category || !Number.isSafeInteger(item.price) || item.price < 0 || item.price > 1_000_000) throw httpError(400, 'Provide a valid dish ID, name, category, and whole-number price.');
  if (!item.category) throw httpError(400, 'Choose Dumplings, Noodles, Sauces, Tteokpokki, or Beverages.');
  if (!Number.isSafeInteger(item.stock) || item.stock < -1 || item.stock > 100_000) throw httpError(400, 'Stock must be a whole number from 0 to 100000, or empty for unlimited.');
  item.soldOut = item.soldOut || (item.stock === 0);
  item.stock = item.soldOut && item.stock === -1 ? 0 : item.stock;
  if (item.image && !/^(https:\/\/|\/uploads\/)[^\s]+$/i.test(item.image)) throw httpError(400, 'Dish photos must use HTTPS or a server-uploaded image.');
  return item;
}

const WORKING_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const defaultWorkingHours = WORKING_DAYS.map(day => ({ day, open: '11:00', close: '23:00', closed: false }));

function validateWorkingHours(body) {
  const source = Array.isArray(body?.hours) ? body.hours : Array.isArray(body) ? body : [];
  const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : '';
  const byDay = new Map(source.map(entry => [String(entry?.day || '').toLowerCase(), entry]));
  return WORKING_DAYS.map(day => {
    const entry = byDay.get(day) || {};
    const open = time(entry.open) || '11:00';
    const close = time(entry.close) || '23:00';
    const closed = Boolean(entry.closed) || !time(entry.open) || !time(entry.close);
    return { day, open, close, closed };
  });
}

function getWorkingHours() {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'workingHours'").get();
  if (!row) return defaultWorkingHours;
  try { return validateWorkingHours(JSON.parse(row.value)); }
  catch { return defaultWorkingHours; }
}

function cairoNow() {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(part => [part.type, part.value]));
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return { day: parts.weekday.toLowerCase(), minutes: hour * 60 + Number(parts.minute) };
}

const toMinutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };

function assertWithinWorkingHours() {
  const { day, minutes } = cairoNow();
  const today = getWorkingHours().find(entry => entry.day === day);
  if (!today || today.closed) throw httpError(423, 'The kitchen is closed right now. Check our working hours and try again later.');
  const open = toMinutes(today.open);
  const close = toMinutes(today.close);
  const within = open <= close ? minutes >= open && minutes < close : minutes >= open || minutes < close;
  if (!within) throw httpError(423, 'The kitchen is closed right now. Check our working hours and try again later.');
}

function validateOffer(body, existingId = null) {
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const id = existingId || (typeof body.id === 'string' && /^[\w-]{1,80}$/.test(body.id) ? body.id : '');
  const title = clean(body.title, 70);
  const description = clean(body.description, 240);
  const discountPercent = Number(body.discountPercent);
  if (!id || !title || !Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100 || typeof body.active !== 'boolean') {
    throw httpError(400, 'Provide an offer ID, title, description, discount from 0–100, and active flag.');
  }
  return { id, title, description, discountPercent, active: body.active };
}

function listCategories() {
  return database.prepare("SELECT name FROM categories WHERE name IN ('Dumplings', 'Noodles', 'Sauces', 'Tteokpokki', 'Beverages') ORDER BY CASE name WHEN 'Dumplings' THEN 1 WHEN 'Noodles' THEN 2 WHEN 'Sauces' THEN 3 WHEN 'Tteokpokki' THEN 4 WHEN 'Beverages' THEN 5 END").all().map(row => row.name);
}

function listMenuItems() {
  return database.prepare('SELECT id, name, category, price, description, image, tag, stock, sold_out AS soldOut FROM menu_items ORDER BY rowid').all();
}

function getMenuItem(id) {
  return database.prepare('SELECT id, name, category, price, description, image, tag, stock, sold_out AS soldOut FROM menu_items WHERE id = ?').get(id);
}

function getOffer(id) {
  return database.prepare('SELECT id, title, description, discount_percent AS discountPercent, active FROM offers WHERE id = ?').get(id);
}

function saveUploadedImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw httpError(400, 'Select a photo to upload.');
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([a-zA-Z0-9+/]+={0,2})$/);
  if (!match) throw httpError(400, 'Upload a JPEG, PNG, or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 2_500_000) throw httpError(413, 'Photos must be smaller than 2.5 MB.');
  let extension;
  if (match[1] === 'jpeg' && bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]) ) && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) extension = 'jpg';
  else if (match[1] === 'png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.toString('ascii', 12, 16) === 'IHDR') extension = 'png';
  else if (match[1] === 'webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  else throw httpError(400, 'The selected file is not a valid JPEG, PNG, or WebP image.');
  const filename = `${randomBytes(20).toString('hex')}.${extension}`;
  writeFileSync(resolve(uploadDirectory, filename), bytes, { flag: 'wx', mode: 0o600 });
  return `/uploads/${filename}`;
}

function readBody(request, maxBytes = 64_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, 'Request is too large.'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > maxBytes) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
        resolveBody(body);
      }
      catch { reject(httpError(400, 'Send valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function validateOrder(body) {
  const cleanText = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const customer = cleanText(body.customer, 70);
  const phone = cleanText(body.phone, 40);
  const email = cleanText(body.email, 254).toLowerCase();
  const address = cleanText(body.address, 240);
  if (!customer || !phone || !email || !address || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) {
    throw httpError(400, 'Add your name, phone, email, address, and at least one item.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email address for order confirmation.');
  if (!['Cash on delivery', 'InstaPay'].includes(body.payment)) throw httpError(400, 'Choose cash on delivery or InstaPay.');
  const items = body.items.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw httpError(400, 'One or more order items are invalid.');
    const id = typeof entry.id === 'string' ? entry.id : '';
    const quantity = Number(entry.quantity);
    const menuItem = database.prepare('SELECT name, category, price, stock, sold_out AS soldOut FROM menu_items WHERE id = ?').get(id);
    if (!menuItem || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw httpError(400, 'One or more order items are invalid.');
    if (menuItem.soldOut) throw httpError(409, `“${menuItem.name}” is sold out today.`);
    if (menuItem.stock >= 0 && quantity > menuItem.stock) throw httpError(409, `Only ${menuItem.stock} left of “${menuItem.name}”.`);
    const style = typeof entry.style === 'string' ? entry.style : '';
    if (menuItem.category === 'Dumplings' && !dumplingStyles.includes(style)) throw httpError(400, `Choose a dumpling style: ${dumplingStyles.join(', ')}.`);
    if (menuItem.category !== 'Dumplings' && style) throw httpError(400, 'Only dumplings can have a preparation style.');
    return { id, name: menuItem.name, category: menuItem.category, quantity, unitPrice: menuItem.price, lineTotal: quantity * menuItem.price, style };
  });
  const subtotal = items.reduce((total, item) => total + item.lineTotal, 0);
  if (!Number.isSafeInteger(subtotal)) throw httpError(400, 'Order total is too large.');
  return { customer, phone, email, address, payment: body.payment, items, subtotal };
}

function getOrder(id) {
  const order = database.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  const items = database.prepare('SELECT name, category, quantity, unit_price AS unitPrice, line_total AS lineTotal, style FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  return { ...order, createdAt: order.created_at, customerEmail: order.email || '', notificationStatus: order.notification_status, items };
}

function listOrders() {
  const orders = database.prepare('SELECT id FROM orders ORDER BY created_at DESC').all();
  return orders.map(({ id }) => getOrder(id));
}

function getEmailTransporter() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.SMTP_FROM?.trim() || process.env.STORE_EMAIL?.trim() || user;
  const storeEmail = process.env.STORE_EMAIL?.trim();
  if (!host || !storeEmail || !user || !pass || !from) return null;
  return createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user, pass }
  });
}

function formatOrderSummary(order, mode) {
  const items = order.items.map(item => `${item.quantity} × ${item.name}${item.style ? ` (${item.style})` : ''}`).join('\n');
  const total = `EGP ${Number(order.subtotal).toLocaleString('en-EG')}`;
  const subject = mode === 'customer' ? `Your Dumpling Lab order ${order.id} is confirmed` : `New Dumpling Lab order ${order.id}`;
  const text = mode === 'customer'
    ? `Thanks for ordering from Dumpling Lab. Your order ${order.id} has been received and is being prepared.\n\nCustomer: ${order.customer}\nPhone: ${order.phone}\nEmail: ${order.email}\nAddress: ${order.address}\nPayment: ${order.payment}\n\nItems:\n${items}\n\nTotal: ${total}`
    : `New order received for Dumpling Lab.\n\nOrder ID: ${order.id}\nCustomer: ${order.customer}\nPhone: ${order.phone}\nEmail: ${order.email}\nAddress: ${order.address}\nPayment: ${order.payment}\n\nItems:\n${items}\n\nTotal: ${total}`;
  return { subject, text };
}

async function sendEmailNotification(order, mode) {
  const transporter = getEmailTransporter();
  if (!transporter) return false;
  const storeEmail = process.env.STORE_EMAIL?.trim();
  const recipient = mode === 'customer' ? order.email : storeEmail;
  if (!recipient) return false;
  const { subject, text } = formatOrderSummary(order, mode);
  await transporter.sendMail({
    from: process.env.SMTP_FROM?.trim() || process.env.STORE_EMAIL?.trim() || process.env.SMTP_USER,
    to: recipient,
    replyTo: mode === 'customer' ? storeEmail : order.email,
    subject,
    text
  });
  return true;
}

async function sendTelegramNotification(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;
  const items = order.items.map(item => `${item.quantity} × ${item.name}${item.style ? ` (${item.style})` : ''}`).join('\n');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `📦 New Dumpling Lab order\nOrder ID: ${order.id}\nCustomer: ${order.customer}\nPhone: ${order.phone}\nEmail: ${order.email}\nAddress: ${order.address}\nPayment: ${order.payment}\n\nItems:\n${items}\n\nTotal: EGP ${Number(order.subtotal).toLocaleString('en-EG')}`,
      disable_web_page_preview: true
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram responded ${response.status}`);
  return true;
}

async function notifyRestaurant(order) {
  const sent = [];
  const webhookURL = process.env.RESTAURANT_WEBHOOK_URL;
  if (webhookURL) {
    try {
      const result = await fetch(webhookURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'new_order', order })
      });
      if (!result.ok) throw new Error(`Webhook responded ${result.status}`);
      sent.push('Webhook');
    } catch (error) {
      console.error('Restaurant webhook failed:', error.message);
    }
  }

  try {
    if (await sendTelegramNotification(order)) sent.push('Telegram');
  } catch (error) {
    console.error('Telegram notification failed:', error.message);
  }

  try {
    if (await sendEmailNotification(order, 'store')) sent.push('Store email');
  } catch (error) {
    console.error('Store email notification failed:', error.message);
  }

  try {
    if (order.email && await sendEmailNotification(order, 'customer')) sent.push('Customer email');
  } catch (error) {
    console.error('Customer email notification failed:', error.message);
  }

  const status = sent.length ? sent.join(', ') : 'Inbox only';
  database.prepare('UPDATE orders SET notification_status = ? WHERE id = ?').run(status, order.id);
}

function csvCell(value) {
  let safe = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[\s]*[=+@\-]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replace(/"/g, '""')}"`;
}

function ordersCSV(orders) {
  const rows = [['Order ID', 'Placed at (UTC)', 'Customer', 'Email', 'Phone', 'Delivery address', 'Items', 'Payment method', 'Subtotal (EGP)', 'Status', 'Restaurant notification']];
  for (const order of orders) rows.push([
    order.id,
    order.createdAt,
    order.customer,
    order.customerEmail || order.email || '',
    order.phone,
    order.address,
    order.items.map(item => `${item.quantity} x ${item.name} (${item.category}${item.style ? `, ${item.style}` : ''})`).join('; '),
    order.payment,
    order.subtotal,
    order.status,
    order.notification_status
  ]);
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function serveStatic(pathname, response) {
  if (pathname.startsWith('/uploads/')) {
    const filename = pathname.slice('/uploads/'.length);
    if (!/^[a-f0-9]{40}\.(?:jpg|png|webp)$/.test(filename)) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const contents = readFileSync(resolve(uploadDirectory, filename));
      const imageType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extname(filename).slice(1)];
      response.writeHead(200, { 'Content-Type': imageType, 'Cache-Control': 'public, max-age=31536000, immutable' }).end(contents);
    } catch {
      response.writeHead(404).end('Not found');
    }
    return;
  }
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (filePath.startsWith(dataDirectory)) {
    response.writeHead(404).end('Not found');
    return;
  }
  let contents;
  try { contents = readFileSync(filePath); }
  catch { response.writeHead(404).end('Not found'); return; }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  response.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
  response.end(contents);
}

const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Dumpling Lab is running at http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { database.close(); server.close(() => process.exit(0)); });
}
