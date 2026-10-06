import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import { createTransport } from 'nodemailer';

const scrypt = promisify(scryptCallback);
const menuCategories = ['Dumplings', 'Noodles', 'Sauces', 'Beverages'];
const dumplingStyles = ['Steamed', 'Pan-fried', 'Crispy skirt'];
const orderStatuses = ['New', 'Preparing', 'Out for delivery', 'Completed', 'Cancelled'];
const paymentMethods = ['Cash on delivery', 'InstaPay'];
const defaultMenu = [
  { id: 'item-1', name: 'Ginger cloud', category: 'Dumplings', price: 185, description: 'Chicken, fresh ginger, and a little spring onion tucked into soft, silky wrappers.', image: 'https://images.unsplash.com/photo-1563245372-f21724e3856d?auto=format&fit=crop&w=900&q=85', tag: 'HOUSE FAVOURITE' },
  { id: 'item-2', name: 'Golden crunch', category: 'Dumplings', price: 210, description: 'Crispy-bottomed parcels, juicy chicken, and sesame soy for dipping.', image: 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', tag: 'CRISPY LITTLE THING' },
  { id: 'item-3', name: 'Mushroom moon', category: 'Dumplings', price: 195, description: 'Earthy shiitake, cabbage, and garlic chives. A lovely little plant-based parcel.', image: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=85', tag: 'PLANT-BASED' },
  { id: 'item-4', name: 'Chilli oil crush', category: 'Dumplings', price: 220, description: 'Pork, a slow-building chilli warmth, and a crackly golden skirt.', image: 'https://images.unsplash.com/photo-1562802378-063ec186a863?auto=format&fit=crop&w=900&q=85', tag: 'A LITTLE HEAT' },
  { id: 'item-5', name: 'The dipping trio', category: 'Sauces', price: 75, description: 'House soy, ginger vinegar, and the chilli oil that started it all.', image: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?auto=format&fit=crop&w=900&q=85', tag: 'THREE IS THE MAGIC NUMBER' },
  { id: 'item-6', name: 'Sesame clouds', category: 'Dumplings', price: 125, description: 'Warm, pillowy sesame buns with a molten sweet black sesame centre.', image: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=900&q=85', tag: 'SOMETHING SWEET' }
];

let clientPromise;
let initializationPromise;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function getDatabase() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    clientPromise = client.connect().catch(error => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise.then(client => client.db(process.env.MONGODB_DB || 'dumpling_lab'));
}

async function initialize() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32) {
        throw new Error('JWT_SECRET must contain at least 32 characters.');
      }
      const db = await getDatabase();
      const users = db.collection('users');
      const menu = db.collection('menu_items');
      const offers = db.collection('offers');
      const orders = db.collection('orders');
      const metadata = db.collection('app_metadata');
      await Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        menu.createIndex({ id: 1 }, { unique: true }),
        offers.createIndex({ id: 1 }, { unique: true }),
        orders.createIndex({ id: 1 }, { unique: true }),
        orders.createIndex({ createdAt: -1 })
      ]);
      const seed = await metadata.updateOne(
        { _id: 'default-menu-v1' },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      if (seed.upsertedCount) {
        try {
          await Promise.all(defaultMenu.map(item => menu.updateOne(
            { id: item.id },
            { $setOnInsert: { ...item, createdAt: new Date() } },
            { upsert: true }
          )));
        } catch (error) {
          await metadata.deleteOne({ _id: 'default-menu-v1' });
          throw error;
        }
      }
      await bootstrapAdmin(users);
      return db;
    })().catch(error => {
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

async function bootstrapAdmin(users) {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password || !isEmail(email) || email.length > 254 || password.length < 12 || password.length > 128) {
    throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of 12–128 characters.');
  }
  const existing = await users.findOne({ email }, { projection: { role: 1 } });
  if (existing) {
    if (existing.role !== 'admin') throw new Error('The bootstrap email belongs to a customer account; use a different email.');
    return;
  }
  const credentials = await hashPassword(password);
  try {
    await users.insertOne({
      id: randomBytes(16).toString('hex'),
      email,
      role: 'admin',
      ...credentials,
      createdAt: new Date().toISOString()
    });
    console.info(`Provisioned the initial administrator account for ${email}.`);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const racedUser = await users.findOne({ email }, { projection: { role: 1 } });
    if (racedUser?.role !== 'admin') throw new Error('The bootstrap email belongs to a customer account; use a different email.');
  }
}

function sendJson(response, status, payload) {
  response.status(status).json(payload);
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

function createToken(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    role: user.role,
    iat: issuedAt,
    exp: issuedAt + 8 * 60 * 60
  })).toString('base64url');
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function authenticate(request, users) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw httpError(401, 'Sign in to continue.');
  const parts = token.split('.');
  if (parts.length !== 3) throw httpError(401, 'Your session is invalid. Please sign in again.');
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
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
  if (!header || header.alg !== 'HS256' || !claims || typeof claims.sub !== 'string'
    || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
    || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError(401, 'Your session is invalid or has expired. Please sign in again.');
  }
  const user = await users.findOne({ id: claims.sub }, { projection: { _id: 0, id: 1, email: 1, role: 1 } });
  if (!user || user.role !== claims.role) throw httpError(401, 'Your account session is no longer valid.');
  return user;
}

async function verifyAdmin(request, users) {
  const user = await authenticate(request, users);
  if (user.role !== 'admin') throw httpError(403, 'Administrator access required.');
  return user;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateCredentials(body, signingUp) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isEmail(email) || email.length > 254) throw httpError(400, 'Enter a valid email address.');
  if (signingUp && (password.length < 12 || password.length > 128)) throw httpError(400, 'Passwords must be 12 to 128 characters long.');
  if (!signingUp && (!password || password.length > 128)) throw httpError(400, 'Enter your password.');
  return { email, password };
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { passwordSalt: salt, passwordHash: (await scrypt(password, salt, 64)).toString('hex') };
}

async function verifyPassword(password, salt, expectedHex) {
  const { passwordHash } = await hashPassword(password, salt);
  const supplied = Buffer.from(passwordHash, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function validateMenuItem(body, existingId = null) {
  const suppliedCategory = cleanText(body.category, 35);
  const category = menuCategories.find(entry => entry.toLowerCase() === suppliedCategory.toLowerCase());
  const item = {
    id: existingId || (typeof body.id === 'string' && /^[\w-]{1,80}$/.test(body.id) ? body.id : ''),
    name: cleanText(body.name, 60),
    category: category || '',
    price: Number(body.price),
    description: cleanText(body.description, 180),
    image: cleanText(body.image, 2_000),
    tag: cleanText(body.tag, 50)
  };
  if (!item.id || !item.name || !item.category || !Number.isSafeInteger(item.price) || item.price < 0 || item.price > 1_000_000) {
    throw httpError(400, 'Provide a valid dish ID, name, category, and whole-number price.');
  }
  if (item.image && !/^https:\/\/[^\s]+$/i.test(item.image)) throw httpError(400, 'Dish photos must use HTTPS.');
  return item;
}

function validateOffer(body, existingId = null) {
  const id = existingId || (typeof body.id === 'string' && /^[\w-]{1,80}$/.test(body.id) ? body.id : '');
  const title = cleanText(body.title, 70);
  const description = cleanText(body.description, 240);
  const discountPercent = Number(body.discountPercent);
  if (!id || !title || !Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100 || typeof body.active !== 'boolean') {
    throw httpError(400, 'Provide an offer ID, title, description, discount from 0–100, and active flag.');
  }
  return { id, title, description, discountPercent, active: body.active };
}

async function validateOrder(body, menu) {
  const customer = cleanText(body.customer, 70);
  const phone = cleanText(body.phone, 40);
  const email = cleanText(body.email, 254).toLowerCase();
  const address = cleanText(body.address, 240);
  if (!customer || !phone || !email || !address || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) {
    throw httpError(400, 'Add your name, phone, email, address, and at least one item.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email address for order confirmation.');
  if (!paymentMethods.includes(body.payment)) throw httpError(400, 'Choose cash on delivery or InstaPay.');
  const submittedItems = body.items.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw httpError(400, 'One or more order items are invalid.');
    return { id: typeof entry.id === 'string' ? entry.id : '', quantity: Number(entry.quantity), style: typeof entry.style === 'string' ? entry.style : '' };
  });
  const menuItems = await menu.find({ id: { $in: submittedItems.map(item => item.id) } }, { projection: { _id: 0, id: 1, name: 1, category: 1, price: 1 } }).toArray();
  const menuById = new Map(menuItems.map(item => [item.id, item]));
  const items = submittedItems.map(entry => {
    const menuItem = menuById.get(entry.id);
    if (!menuItem || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 99) throw httpError(400, 'One or more order items are invalid.');
    if (menuItem.category === 'Dumplings' && !dumplingStyles.includes(entry.style)) throw httpError(400, `Choose a dumpling style: ${dumplingStyles.join(', ')}.`);
    if (menuItem.category !== 'Dumplings' && entry.style) throw httpError(400, 'Only dumplings can have a preparation style.');
    return {
      name: menuItem.name,
      category: menuItem.category,
      quantity: entry.quantity,
      unitPrice: menuItem.price,
      lineTotal: entry.quantity * menuItem.price,
      style: entry.style
    };
  });
  const subtotal = items.reduce((total, item) => total + item.lineTotal, 0);
  if (!Number.isSafeInteger(subtotal)) throw httpError(400, 'Order total is too large.');
  return { customer, phone, email, address, payment: body.payment, items, subtotal };
}

function publicDocument(document) {
  if (!document) return null;
  const { _id, ...result } = document;
  return result;
}

function csvCell(value) {
  let safe = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[\s]*[=+@\-]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replace(/"/g, '""')}"`;
}

function ordersCsv(orders) {
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
    order.notificationStatus
  ]);
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function getRequestBody(request) {
  const body = request.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try {
      const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      throw httpError(400, 'Send valid JSON.');
    }
    throw httpError(400, 'Send a JSON object.');
  }
  return {};
}

function validateImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw httpError(400, 'Select a photo to upload.');
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([a-zA-Z0-9+/]+={0,2})$/);
  if (!match) throw httpError(400, 'Upload a JPEG, PNG, or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 2_500_000) throw httpError(413, 'Photos must be smaller than 2.5 MB.');
  const isJpeg = match[1] === 'jpeg' && bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]));
  const isPng = match[1] === 'png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.toString('ascii', 12, 16) === 'IHDR';
  const isWebp = match[1] === 'webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) throw httpError(400, 'The selected file is not a valid JPEG, PNG, or WebP image.');
  return { bytes, extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

async function uploadImageToCloudinary(dataUrl) {
  const { bytes, extension } = validateImageDataUrl(dataUrl);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('Cloudinary upload credentials are not configured.');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = 'dumpling-lab/menu';
  const signatureInput = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(signatureInput).digest('hex');
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` }), `menu-photo.${extension}`);
  form.set('api_key', apiKey);
  form.set('timestamp', timestamp);
  form.set('folder', folder);
  form.set('signature', signature);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: 'POST', body: form });
  const result = await response.json();
  if (!response.ok || typeof result.secure_url !== 'string') {
    console.error('Cloudinary upload failed:', result.error?.message || response.statusText);
    throw httpError(502, 'The photo could not be uploaded. Please try again.');
  }
  return result.secure_url;
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
    }),
    signal: AbortSignal.timeout(4000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram responded ${response.status}`);
  return true;
}

async function sendRestaurantNotification(order, orders) {
  const sent = [];
  const webhookURL = process.env.RESTAURANT_WEBHOOK_URL;
  if (webhookURL) {
    try {
      const result = await fetch(webhookURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'new_order', order }),
        signal: AbortSignal.timeout(4000)
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

  const notificationStatus = sent.length ? sent.join(', ') : 'Inbox only';
  await orders.updateOne({ id: order.id }, { $set: { notificationStatus, notification_status: notificationStatus } });
}

async function handleApi(request, response, db, url) {
  const { pathname } = url;
  const method = request.method;
  const users = db.collection('users');
  const menu = db.collection('menu_items');
  const offers = db.collection('offers');
  const orders = db.collection('orders');
  const body = getRequestBody(request);

  if (pathname === '/api/auth/signup' && method === 'POST') {
    const { email, password } = validateCredentials(body, true);
    const credentials = await hashPassword(password);
    const user = { id: randomBytes(16).toString('hex'), email, role: 'customer', ...credentials, createdAt: new Date().toISOString() };
    try {
      await users.insertOne(user);
    } catch (error) {
      if (error.code === 11000) throw httpError(409, 'An account with that email already exists.');
      throw error;
    }
    sendJson(response, 201, { token: createToken(user), user: publicUser(user) });
    return;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const { email, password } = validateCredentials(body, false);
    const user = await users.findOne({ email });
    const valid = user ? await verifyPassword(password, user.passwordSalt, user.passwordHash) : await verifyPassword(password, 'invalid-salt', '0'.repeat(128));
    if (!user || !valid) throw httpError(401, 'Email or password is incorrect.');
    sendJson(response, 200, { token: createToken(user), user: publicUser(user) });
    return;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = await authenticate(request, users);
    sendJson(response, 200, { user: publicUser(user) });
    return;
  }

  if (pathname === '/api/menu' && method === 'GET') {
    const items = await menu.find({}, { projection: { _id: 0, createdAt: 0 } }).sort({ createdAt: 1 }).toArray();
    sendJson(response, 200, { categories: menuCategories, items });
    return;
  }

  if (pathname === '/api/offers' && method === 'GET') {
    const includeInactive = url.searchParams.get('all') === 'true';
    if (includeInactive) await verifyAdmin(request, users);
    const query = includeInactive ? {} : { active: true };
    const activeOffers = await offers.find(query, { projection: { _id: 0 } }).sort({ title: 1 }).toArray();
    sendJson(response, 200, { offers: activeOffers });
    return;
  }

  if (pathname === '/api/uploads' && method === 'POST') {
    await verifyAdmin(request, users);
    const image = await uploadImageToCloudinary(body.dataUrl);
    sendJson(response, 201, { image });
    return;
  }

  if (pathname === '/api/orders' && method === 'POST') {
    const orderData = await validateOrder(body, menu);
    const id = `DL-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const notificationStatus = 'Inbox';
    const order = {
      id,
      ...orderData,
      customerEmail: orderData.email,
      status: 'New',
      notificationStatus,
      notification_status: notificationStatus,
      createdAt: new Date().toISOString()
    };
    await orders.insertOne({ ...order });
    await sendRestaurantNotification(order, orders);
    sendJson(response, 201, { order });
    return;
  }

  if (pathname === '/api/orders' && method === 'GET') {
    await verifyAdmin(request, users);
    const allOrders = await orders.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    sendJson(response, 200, { orders: allOrders });
    return;
  }

  if (pathname === '/api/orders.csv' && method === 'GET') {
    await verifyAdmin(request, users);
    const allOrders = await orders.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="dumpling-lab-orders.csv"');
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).send(ordersCsv(allOrders));
    return;
  }

  const orderStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (orderStatusMatch && method === 'PATCH') {
    await verifyAdmin(request, users);
    const status = body.status;
    if (!orderStatuses.includes(status)) throw httpError(400, 'Choose a valid order status.');
    const id = decodeURIComponent(orderStatusMatch[1]);
    const result = await orders.updateOne({ id }, { $set: { status } });
    if (!result.matchedCount) throw httpError(404, 'Order not found.');
    const updatedOrder = publicDocument(await orders.findOne({ id }));
    sendJson(response, 200, { order: updatedOrder });
    return;
  }

  if (pathname === '/api/categories' && method === 'POST') {
    await verifyAdmin(request, users);
    const name = typeof body.name === 'string' ? menuCategories.find(category => category.toLowerCase() === body.name.trim().toLowerCase()) : null;
    if (!name) throw httpError(400, 'Choose one of the fixed menu categories: Dumplings, Noodles, Sauces, or Beverages.');
    throw httpError(409, 'That category already exists.');
    return;
  }

  if (/^\/api\/categories\/[^/]+$/.test(pathname) && method === 'DELETE') {
    await verifyAdmin(request, users);
    throw httpError(400, 'The menu categories are fixed: Dumplings, Noodles, Sauces, and Beverages.');
  }

  if (pathname === '/api/menu' && method === 'POST') {
    await verifyAdmin(request, users);
    const item = validateMenuItem(body);
    try {
      await menu.insertOne({ ...item, createdAt: new Date() });
    } catch (error) {
      if (error.code === 11000) throw httpError(409, 'That menu item ID already exists.');
      throw error;
    }
    sendJson(response, 201, { item });
    return;
  }

  const menuItemMatch = pathname.match(/^\/api\/menu\/([^/]+)$/);
  if (menuItemMatch && (method === 'PUT' || method === 'DELETE')) {
    await verifyAdmin(request, users);
    const id = decodeURIComponent(menuItemMatch[1]);
    if (method === 'DELETE') {
      const result = await menu.deleteOne({ id });
      if (!result.deletedCount) throw httpError(404, 'Menu item not found.');
      sendJson(response, 200, { ok: true });
      return;
    }
    const item = validateMenuItem(body, id);
    const result = await menu.updateOne({ id }, { $set: item });
    if (!result.matchedCount) throw httpError(404, 'Menu item not found.');
    sendJson(response, 200, { item });
    return;
  }

  if (pathname === '/api/offers' && method === 'POST') {
    await verifyAdmin(request, users);
    const offer = validateOffer(body);
    try {
      await offers.insertOne({ ...offer, createdAt: new Date() });
    } catch (error) {
      if (error.code === 11000) throw httpError(409, 'That offer ID already exists.');
      throw error;
    }
    sendJson(response, 201, { offer });
    return;
  }

  const offerMatch = pathname.match(/^\/api\/offers\/([^/]+)$/);
  if (offerMatch && (method === 'PUT' || method === 'DELETE')) {
    await verifyAdmin(request, users);
    const id = decodeURIComponent(offerMatch[1]);
    if (method === 'DELETE') {
      const result = await offers.deleteOne({ id });
      if (!result.deletedCount) throw httpError(404, 'Offer not found.');
      sendJson(response, 200, { ok: true });
      return;
    }
    const offer = validateOffer(body, id);
    const result = await offers.updateOne({ id }, { $set: offer });
    if (!result.matchedCount) throw httpError(404, 'Offer not found.');
    sendJson(response, 200, { offer });
    return;
  }

  throw httpError(404, 'Not found.');
}

export async function handleRequest(request, response, routePath) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  try {
    const db = await initialize();
    const url = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`);
    if (routePath) url.pathname = `/api/${routePath}`;
    await handleApi(request, response, db, url);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(response, status, { error: status >= 500 ? 'The request could not be processed.' : error.message });
  }
}

export default function handler(request, response) {
  return handleRequest(request, response);
}
