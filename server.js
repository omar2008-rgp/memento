const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-1234';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret-in-production';
const ADMIN_TOKEN_TTL = 24 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL is not set. Create a PostgreSQL database before production.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

async function dbQuery(text, params = []) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
  `);
}

async function getBrand() {
  const { rows } = await dbQuery('SELECT data FROM brands ORDER BY updated_at DESC LIMIT 1');
  return rows[0]?.data || null;
}
async function saveBrand(brand) {
  await dbQuery('DELETE FROM brands');
  await dbQuery('INSERT INTO brands (id, data) VALUES ($1, $2)', [brand.id, brand]);
}
async function getProducts() {
  const { rows } = await dbQuery('SELECT data FROM products ORDER BY created_at ASC');
  return rows.map(r => r.data);
}
async function getOrders() {
  const { rows } = await dbQuery('SELECT data FROM orders ORDER BY created_at ASC');
  return rows.map(r => r.data);
}
async function getUsers() {
  const { rows } = await dbQuery('SELECT data FROM users ORDER BY created_at ASC');
  return rows.map(r => r.data);
}

// ===== إدارة جلسات الأدمن =====
const adminSessions = new Map();
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ===== دوال المصادقة للمستخدمين =====
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}
function authenticateUser(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ===== مسارات الأدمن =====
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { expiresAt: Date.now() + ADMIN_TOKEN_TTL });
  res.json({ success: true, token, expiresAt: Date.now() + ADMIN_TOKEN_TTL });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  adminSessions.delete(token);
  res.json({ success: true });
});

// الصور تُحفظ داخل قاعدة البيانات كـ data URL، لذلك لا تعتمد على قرص السيرفر المؤقت.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  }
});
app.post('/api/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'يرجى اختيار صورة JPG أو PNG أو WEBP أو GIF' });
  const image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  res.json({ success: true, url: image });
});

// ===== البراند والمنتجات والطلبات =====
app.get('/api/admin/brand', requireAdmin, async (_req, res) => {
  try { res.json(await getBrand()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.post('/api/admin/brand', requireAdmin, async (req, res) => {
  try {
    const brand = { ...req.body, id: req.body.id || uuidv4() };
    await saveBrand(brand);
    res.json({ success: true, brand });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/admin/products', requireAdmin, async (_req, res) => {
  try { res.json(await getProducts()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const product = {
      ...req.body,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      price: Number(req.body.price) || 0,
      quantity: Math.max(0, Number.parseInt(req.body.quantity, 10) || 0),
      images: Array.isArray(req.body.images) ? req.body.images.filter(Boolean) : []
    };
    if (!product.name || product.images.length === 0) return res.status(400).json({ error: 'اسم المنتج والصورة مطلوبان' });
    await dbQuery('INSERT INTO products (id, data) VALUES ($1, $2)', [product.id, product]);
    res.json({ success: true, product });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await dbQuery('SELECT data FROM products WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    const updated = {
      ...rows[0].data,
      ...req.body,
      id: rows[0].data.id,
      updatedAt: new Date().toISOString()
    };
    if (req.body.price !== undefined) updated.price = Number(req.body.price) || 0;
    if (req.body.quantity !== undefined) updated.quantity = Math.max(0, Number.parseInt(req.body.quantity, 10) || 0);
    if (req.body.images !== undefined) updated.images = Array.isArray(req.body.images) ? req.body.images.filter(Boolean) : [];
    if (!updated.name || !updated.images || updated.images.length === 0) return res.status(400).json({ error: 'اسم المنتج والصورة مطلوبان' });
    await dbQuery('UPDATE products SET data = $1, updated_at = NOW() WHERE id = $2', [updated, req.params.id]);
    res.json({ success: true, product: updated });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  try { res.json(await getOrders()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const users = await getUsers();
    res.json(users.map(({ password, ...safe }) => safe));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const orders = await getOrders();
    const users = await getUsers();
    const totalRevenue = orders.reduce((sum, o) => sum + (Number(o.totalPrice) || 0), 0);
    res.json({ totalRevenue, totalOrders: orders.length, totalUsers: users.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// ===== المستخدمون =====
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, address } = req.body;
    if (!name || !email || !password || !phone || !address) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await dbQuery('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows[0]) return res.status(400).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: uuidv4(), name, email: normalizedEmail, password: hashedPassword, phone, address, createdAt: new Date().toISOString() };
    await dbQuery('INSERT INTO users (id, email, data) VALUES ($1, $2, $3)', [newUser.id, newUser.email, newUser]);
    res.status(201).json({ success: true, token: generateToken(newUser.id), user: { id: newUser.id, name: newUser.name, email: newUser.email, phone: newUser.phone, address: newUser.address } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
    const normalizedEmail = String(email).trim().toLowerCase();
    const { rows } = await dbQuery('SELECT data FROM users WHERE email = $1', [normalizedEmail]);
    const user = rows[0]?.data;
    if (!user) return res.status(401).json({ error: 'البريد الإلكتروني غير صحيح' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
    res.json({ success: true, token: generateToken(user.id), user: { id: user.id, name: user.name, email: user.email, phone: user.phone, address: user.address } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/auth/me', authenticateUser, async (req, res) => {
  try {
    const { rows } = await dbQuery('SELECT data FROM users WHERE id = $1', [req.userId]);
    const user = rows[0]?.data;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone, address: user.address });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.put('/api/auth/me', authenticateUser, async (req, res) => {
  try {
    const { rows } = await dbQuery('SELECT data FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = rows[0].data;
    const { name, phone, address, password } = req.body;
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (address) user.address = address;
    if (password) user.password = await bcrypt.hash(password, 10);
    await dbQuery('UPDATE users SET data = $1, updated_at = NOW() WHERE id = $2', [user, req.userId]);
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, address: user.address } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

// ===== المتجر =====
app.get('/api/store/products', async (_req, res) => {
  try {
    const products = await getProducts();
    res.json(products.map(p => ({ id: p.id, name: p.name, price: p.price, description: p.description, images: p.images, quantity: p.quantity > 10 ? null : p.quantity })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.get('/api/store/brand', async (_req, res) => {
  try {
    const brand = await getBrand();
    if (!brand) return res.json(null);
    res.json({ name: brand.name, logo: brand.logo, phone: brand.phone, email: brand.email, instagram: brand.instagram, tiktok: brand.tiktok, whatsapp: brand.whatsapp, facebook: brand.facebook });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/store/orders', authenticateUser, async (req, res) => {
  try {
    const order = { ...req.body, userId: req.userId, id: uuidv4(), createdAt: new Date().toISOString(), status: 'new' };
    await dbQuery('INSERT INTO orders (id, user_id, data) VALUES ($1, $2, $3)', [order.id, order.userId, order]);
    res.json({ success: true, order });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});
app.post('/api/store/orders/guest', async (req, res) => {
  try {
    const order = { ...req.body, userId: null, id: uuidv4(), createdAt: new Date().toISOString(), status: 'new' };
    await dbQuery('INSERT INTO orders (id, user_id, data) VALUES ($1, $2, $3)', [order.id, null, order]);
    res.json({ success: true, order });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Database error' }); }
});

app.get('/', (req, res) => {
  const host = req.headers.host || '';
  if (host.includes('admin')) return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      if (ADMIN_PASSWORD === 'change-me-1234') console.warn('⚠️ Set ADMIN_PASSWORD before production.');
    });
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    process.exit(1);
  }
}

start();
module.exports = app;
