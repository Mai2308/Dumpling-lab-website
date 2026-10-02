import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dataDirectory = resolve(root, 'data');
mkdirSync(dataDirectory, { recursive: true });
const tokenPath = resolve(dataDirectory, 'admin-token');
if (!process.env.ADMIN_TOKEN && !existsSync(tokenPath)) {
  writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  console.log(`Generated staff access token: ${readFileSync(tokenPath, 'utf8')}`);
}
const adminToken = process.env.ADMIN_TOKEN || readFileSync(tokenPath, 'utf8').trim();
const database = new DatabaseSync(resolve(dataDirectory, 'orders.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    payment TEXT NOT NULL CHECK (payment IN ('Cash on delivery', 'InstaPay')),
    subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
    status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled')),
    notification_status TEXT NOT NULL DEFAULT 'Inbox',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    line_total INTEGER NOT NULL CHECK (line_total >= 0)
  );
  CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
`);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  setCommonHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  try {
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      const body = await readBody(request);
      const order = validateOrder(body);
      const id = `DL-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
      const createdAt = new Date().toISOString();
      const insertOrder = database.prepare('INSERT INTO orders (id, customer, phone, address, payment, subtotal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insertItem = database.prepare('INSERT INTO order_items (order_id, name, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)');
      database.exec('BEGIN IMMEDIATE');
      try {
        insertOrder.run(id, order.customer, order.phone, order.address, order.payment, order.subtotal, createdAt);
        for (const item of order.items) insertItem.run(id, item.name, item.category, item.quantity, item.unitPrice, item.lineTotal);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }

      const savedOrder = getOrder(id);
      notifyRestaurant(savedOrder).catch(error => console.error('Order notification failed:', error.message));
      json(response, 201, { order: savedOrder });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!isAuthorized(request)) {
        json(response, 401, { error: 'Staff access required.' });
        return;
      }

      if (url.pathname === '/api/orders' && request.method === 'GET') {
        json(response, 200, { orders: listOrders() });
        return;
      }
      if (url.pathname === '/api/orders.csv' && request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="dumpling-lab-orders.csv"',
          'Cache-Control': 'no-store'
        }).end(ordersCSV(listOrders()));
        return;
      }
      const statusMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
      if (statusMatch && request.method === 'PATCH') {
        const { status } = await readBody(request);
        const allowed = ['New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled'];
        if (!allowed.includes(status)) {
          json(response, 400, { error: 'Choose a valid order status.' });
          return;
        }
        const result = database.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, decodeURIComponent(statusMatch[1]));
        if (!result.changes) {
          json(response, 404, { error: 'Order not found.' });
          return;
        }
        json(response, 200, { order: getOrder(decodeURIComponent(statusMatch[1])) });
        return;
      }
      json(response, 404, { error: 'Not found.' });
      return;
    }

    serveStatic(url.pathname, response);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error(error);
    json(response, status, { error: status === 500 ? 'The order could not be processed.' : error.message });
  }
});

function setCommonHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function isAuthorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(adminToken);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 64_000) {
        reject(Object.assign(new Error('Request is too large.'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolveBody(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Send valid JSON.'), { statusCode: 400 })); }
    });
    request.on('error', reject);
  });
}

function validateOrder(body) {
  const cleanText = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const customer = cleanText(body.customer, 70);
  const phone = cleanText(body.phone, 40);
  const address = cleanText(body.address, 240);
  if (!customer || !phone || !address || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) {
    throw Object.assign(new Error('Add your name, phone, address, and at least one item.'), { statusCode: 400 });
  }
  if (!['Cash on delivery', 'InstaPay'].includes(body.payment)) {
    throw Object.assign(new Error('Choose cash on delivery or InstaPay.'), { statusCode: 400 });
  }
  const items = body.items.map(item => {
    const name = cleanText(item.name, 80);
    const category = cleanText(item.category, 50);
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    if (!name || !category || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || !Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000) {
      throw Object.assign(new Error('One or more order items are invalid.'), { statusCode: 400 });
    }
    return { name, category, quantity, unitPrice, lineTotal: quantity * unitPrice };
  });
  const subtotal = items.reduce((total, item) => total + item.lineTotal, 0);
  if (!Number.isSafeInteger(subtotal)) throw Object.assign(new Error('Order total is too large.'), { statusCode: 400 });
  return { customer, phone, address, payment: body.payment, items, subtotal };
}

function getOrder(id) {
  const order = database.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  const items = database.prepare('SELECT name, category, quantity, unit_price AS unitPrice, line_total AS lineTotal FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  return { ...order, createdAt: order.created_at, notificationStatus: order.notification_status, items };
}

function listOrders() {
  const orders = database.prepare('SELECT id FROM orders ORDER BY created_at DESC').all();
  return orders.map(({ id }) => getOrder(id));
}

async function notifyRestaurant(order) {
  const webhookURL = process.env.RESTAURANT_WEBHOOK_URL;
  if (!webhookURL) return;
  try {
    const result = await fetch(webhookURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'new_order', order })
    });
    if (!result.ok) throw new Error(`Webhook responded ${result.status}`);
    database.prepare("UPDATE orders SET notification_status = 'Webhook sent' WHERE id = ?").run(order.id);
  } catch (error) {
    database.prepare("UPDATE orders SET notification_status = 'Inbox only' WHERE id = ?").run(order.id);
    throw error;
  }
}

function csvCell(value) {
  let safe = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[\s]*[=+@\-]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replace(/"/g, '""')}"`;
}

function ordersCSV(orders) {
  const rows = [['Order ID', 'Placed at (UTC)', 'Customer', 'Phone', 'Delivery address', 'Items', 'Payment method', 'Subtotal (EGP)', 'Status', 'Restaurant notification']];
  for (const order of orders) {
    rows.push([
      order.id,
      order.createdAt,
      order.customer,
      order.phone,
      order.address,
      order.items.map(item => `${item.quantity} x ${item.name} (${item.category})`).join('; '),
      order.payment,
      order.subtotal,
      order.status,
      order.notification_status
    ]);
  }
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function serveStatic(pathname, response) {
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
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
  response.end(contents);
}

const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Dumpling Lab is running at http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { database.close(); server.close(() => process.exit(0)); });
}