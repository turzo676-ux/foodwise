function _DB(f){const d=new(require('node:sqlite').DatabaseSync)(f);let t=0;d.pragma=s=>d.exec('PRAGMA '+s);d.transaction=fn=>(...a)=>{const s='s'+(++t);d.exec('SAVEPOINT '+s);try{const r=fn(...a);d.exec('RELEASE '+s);t--;return r}catch(e){d.exec('ROLLBACK TO '+s+';RELEASE '+s);t--;throw e}};return d};
const express = require('express'), Database = _DB, bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), path = require('path');
const PORT = process.env.PORT || 3000, SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'foodwise.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT DEFAULT 'admin');
CREATE TABLE IF NOT EXISTS foods(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, category TEXT, unit TEXT DEFAULT 'pcs', min_stock REAL DEFAULT 0, unit_price REAL DEFAULT 0, barcode TEXT);
CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY, food_id INTEGER NOT NULL REFERENCES foods(id), qty REAL NOT NULL, unit_price REAL NOT NULL, total_cost REAL NOT NULL, expiry_date TEXT NOT NULL, purchased_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY, food_id INTEGER NOT NULL REFERENCES foods(id), purchase_id INTEGER REFERENCES purchases(id), qty REAL NOT NULL, unit_price REAL NOT NULL, expiry_date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consumptions(id INTEGER PRIMARY KEY, food_id INTEGER NOT NULL, batch_id INTEGER, qty REAL NOT NULL, used_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS waste(id INTEGER PRIMARY KEY, food_id INTEGER NOT NULL, batch_id INTEGER, qty REAL NOT NULL, cost REAL NOT NULL, reason TEXT, wasted_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS donations(id INTEGER PRIMARY KEY, food_id INTEGER NOT NULL, qty REAL NOT NULL, value REAL NOT NULL, organization TEXT, donated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_batches_exp ON batches(expiry_date);
`);
if (!db.prepare('SELECT 1 FROM users').get()) {
  const u = process.env.ADMIN_USER || 'admin', p = process.env.ADMIN_PASS || 'admin123';
  db.prepare('INSERT INTO users(username,password_hash) VALUES(?,?)').run(u, bcrypt.hashSync(p, 10));
  console.log(`Default user created: ${u} (set ADMIN_USER / ADMIN_PASS in production!)`);
}
const ds = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return ds(d); };
const today = () => addDays(0);
const httpErr = (status, error) => Object.assign(new Error(error), { status });
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw httpErr(400, name + ' is invalid'); return n; };
const food = id => db.prepare('SELECT * FROM foods WHERE id=?').get(id);

const app = express(); app.use(express.json());

// ---- Login ----
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '12h' }), username: u.username });
});
app.use('/api', (req, res, next) => {
  try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Unauthorized' }); }
});

// ---- Food Entry / Food List ----
app.get('/api/foods', (req, res) => {
  res.json(req.query.barcode ? db.prepare('SELECT * FROM foods WHERE barcode=?').all(req.query.barcode) : db.prepare('SELECT * FROM foods ORDER BY name').all());
});
app.post('/api/foods', (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim();
  if (!name) throw httpErr(400, 'name is required');
  const ex = db.prepare('SELECT id FROM foods WHERE name=?').get(name);
  if (ex) {
    db.prepare("UPDATE foods SET category=COALESCE(?,category), unit=COALESCE(?,unit), min_stock=COALESCE(?,min_stock), unit_price=COALESCE(?,unit_price), barcode=COALESCE(NULLIF(?,''),barcode) WHERE id=?")
      .run(b.category ?? null, b.unit ?? null, b.min_stock ?? null, b.unit_price ?? null, b.barcode ?? null, ex.id);
    return res.json(food(ex.id));
  }
  const r = db.prepare('INSERT INTO foods(name,category,unit,min_stock,unit_price,barcode) VALUES(?,?,?,?,?,?)')
    .run(name, b.category || null, b.unit || 'pcs', num(b.min_stock || 0, 'min_stock'), num(b.unit_price || 0, 'unit_price'), b.barcode || null);
  res.status(201).json(food(r.lastInsertRowid));
});

// ---- Inventory / Stock Update ----
app.get('/api/inventory', (req, res) => {
  res.json(db.prepare(`SELECT b.id, b.food_id, f.name, f.unit, f.min_stock AS min, b.unit_price AS price, b.qty, b.expiry_date AS exp, f.barcode AS code
    FROM batches b JOIN foods f ON f.id=b.food_id WHERE b.qty>0 ORDER BY b.expiry_date, f.name`).all());
});
app.put('/api/batches/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id=?').get(req.params.id);
  if (!b) throw httpErr(404, 'Batch not found');
  const q = req.body.qty != null ? num(req.body.qty, 'qty') : b.qty, e = req.body.expiry_date || b.expiry_date;
  db.prepare('UPDATE batches SET qty=?, expiry_date=? WHERE id=?').run(q, e, b.id);
  res.json({ id: b.id, qty: q, expiry_date: e });
});
app.delete('/api/batches/:id', (req, res) => { db.prepare('DELETE FROM batches WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Expiry Alert (expired, expiring soon, low stock) ----
app.get('/api/expiry-alerts', (req, res) => {
  const days = Number(req.query.days) || 3, q = `SELECT b.id, b.food_id, f.name, f.unit, f.min_stock AS min, b.qty, b.expiry_date AS exp FROM batches b JOIN foods f ON f.id=b.food_id WHERE b.qty>0 AND `;
  res.json({
    expired: db.prepare(q + 'b.expiry_date < ? ORDER BY b.expiry_date').all(today()),
    expiring: db.prepare(q + 'b.expiry_date >= ? AND b.expiry_date <= ? ORDER BY b.expiry_date').all(today(), addDays(days)),
    low: db.prepare(`SELECT f.id, f.id AS food_id, f.name, f.unit, f.min_stock AS min, COALESCE(SUM(b.qty),0) AS qty FROM foods f
      LEFT JOIN batches b ON b.food_id=f.id AND b.qty>0 GROUP BY f.id HAVING qty <= f.min_stock ORDER BY f.name`).all()
  });
});

// ---- Consumption (batch_id, or food_id => FEFO across batches) ----
app.post('/api/consumptions', (req, res) => {
  const { batch_id, food_id } = req.body || {}, q = num(req.body.qty, 'qty');
  if (!q) throw httpErr(400, 'qty must be greater than 0');
  const used = db.transaction(() => {
    const rows = batch_id ? db.prepare('SELECT * FROM batches WHERE id=? AND qty>0').all(batch_id)
      : food_id ? db.prepare('SELECT * FROM batches WHERE food_id=? AND qty>0 ORDER BY expiry_date').all(food_id)
      : (() => { throw httpErr(400, 'batch_id or food_id is required'); })();
    if (!rows.length) throw httpErr(404, 'No stock found');
    let left = q, total = 0;
    for (const b of rows) {
      if (left <= 0) break;
      const t = Math.min(left, b.qty);
      db.prepare('UPDATE batches SET qty=ROUND(qty-?,4) WHERE id=?').run(t, b.id);
      db.prepare('INSERT INTO consumptions(food_id,batch_id,qty,used_at) VALUES(?,?,?,?)').run(b.food_id, b.id, t, today());
      left -= t; total += t;
    }
    return total;
  })();
  res.status(201).json({ consumed: used });
});
app.get('/api/consumptions', (req, res) => {
  res.json(db.prepare(`SELECT f.name AS n, c.qty AS q, c.used_at AS d FROM consumptions c JOIN foods f ON f.id=c.food_id WHERE c.used_at >= ? ORDER BY c.used_at`).all(addDays(-(Number(req.query.days) || 30))));
});

// ---- Waste + Analytics ----
app.post('/api/waste', (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id=?').get((req.body || {}).batch_id);
  if (!b || b.qty <= 0) throw httpErr(404, 'Batch not found');
  const q = Math.min(req.body.qty != null ? num(req.body.qty, 'qty') : b.qty, b.qty);
  db.transaction(() => {
    db.prepare('UPDATE batches SET qty=ROUND(qty-?,4) WHERE id=?').run(q, b.id);
    db.prepare('INSERT INTO waste(food_id,batch_id,qty,cost,reason,wasted_at) VALUES(?,?,?,?,?,?)')
      .run(b.food_id, b.id, q, q * b.unit_price, req.body.reason || (b.expiry_date < today() ? 'expired' : 'other'), today());
  })();
  res.status(201).json({ wasted: q, cost: q * b.unit_price });
});
app.get('/api/waste/analytics', (req, res) => {
  const t = db.prepare('SELECT COALESCE(SUM(cost),0) AS total, COUNT(*) AS count FROM waste').get();
  res.json({
    total: t.total, count: t.count,
    byFood: db.prepare('SELECT f.name, SUM(w.qty) AS qty, SUM(w.cost) AS cost FROM waste w JOIN foods f ON f.id=w.food_id GROUP BY f.id ORDER BY cost DESC').all(),
    byMonth: db.prepare("SELECT substr(wasted_at,1,7) AS month, SUM(cost) AS cost FROM waste GROUP BY month ORDER BY month").all(),
    entries: db.prepare('SELECT w.id, f.name AS n, w.qty AS q, w.cost AS c, w.wasted_at AS d, w.reason FROM waste w JOIN foods f ON f.id=w.food_id ORDER BY w.wasted_at, w.id').all()
  });
});

// ---- Purchase (creates a stock batch) ----
app.post('/api/purchases', (req, res) => {
  const b = req.body || {}, f = food(b.food_id);
  if (!f) throw httpErr(404, 'Food not found');
  const q = num(b.qty, 'qty'), p = num(b.unit_price ?? f.unit_price, 'unit_price');
  if (!q) throw httpErr(400, 'qty must be greater than 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date || '')) throw httpErr(400, 'expiry_date must be YYYY-MM-DD');
  const id = db.transaction(() => {
    const pr = db.prepare('INSERT INTO purchases(food_id,qty,unit_price,total_cost,expiry_date,purchased_at) VALUES(?,?,?,?,?,?)').run(f.id, q, p, q * p, b.expiry_date, today());
    return db.prepare('INSERT INTO batches(food_id,purchase_id,qty,unit_price,expiry_date) VALUES(?,?,?,?,?)').run(f.id, pr.lastInsertRowid, q, p, b.expiry_date).lastInsertRowid;
  })();
  res.status(201).json({ batch_id: id });
});
app.get('/api/purchases', (req, res) => {
  res.json(db.prepare('SELECT p.*, f.name FROM purchases p JOIN foods f ON f.id=p.food_id ORDER BY p.id DESC LIMIT 200').all());
});

// ---- Donation ----
app.post('/api/donations', (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id=?').get((req.body || {}).batch_id);
  if (!b || b.qty <= 0) throw httpErr(404, 'Batch not found');
  const q = Math.min(req.body.qty != null ? num(req.body.qty, 'qty') : b.qty, b.qty);
  db.transaction(() => {
    db.prepare('UPDATE batches SET qty=ROUND(qty-?,4) WHERE id=?').run(q, b.id);
    db.prepare('INSERT INTO donations(food_id,qty,value,organization,donated_at) VALUES(?,?,?,?,?)').run(b.food_id, q, q * b.unit_price, req.body.organization || null, today());
  })();
  res.status(201).json({ donated: q });
});
app.get('/api/donations', (req, res) => {
  res.json(db.prepare('SELECT d.id, f.name AS n, d.qty AS q, f.unit AS u, d.value AS c, d.donated_at AS d, d.organization FROM donations d JOIN foods f ON f.id=d.food_id ORDER BY d.id').all());
});

// ---- Demo data (only when DB is empty) ----
app.post('/api/seed', (req, res) => {
  if (db.prepare('SELECT 1 FROM foods').get()) return res.json({ skipped: true });
  const F = [['Milk', 'L', 2, 90, 2, 6, '8901234567890'], ['Egg', 'pcs', 6, 14, -1, 18, '8901234500011'], ['Tomato', 'kg', 1, 60, 1, 1, '8901234500022'], ['Chicken', 'kg', 1, 220, 2, 3, '8901234500033'],
    ['Rice', 'kg', 5, 75, 180, 4, '8901234500044'], ['Onion', 'kg', 2, 50, 30, 6, '8901234500055'], ['Potato', 'kg', 2, 40, 25, 2, '8901234500066'], ['Bread', 'pcs', 1, 50, 3, 3, '8901234500077']];
  db.transaction(() => {
    F.forEach(([n, u, m, p, d, q, code], i) => {
      const id = db.prepare('INSERT INTO foods(name,unit,min_stock,unit_price,barcode) VALUES(?,?,?,?,?)').run(n, u, m, p, code).lastInsertRowid;
      const pr = db.prepare('INSERT INTO purchases(food_id,qty,unit_price,total_cost,expiry_date,purchased_at) VALUES(?,?,?,?,?,?)').run(id, q, p, q * p, addDays(d), addDays(-5)).lastInsertRowid;
      db.prepare('INSERT INTO batches(food_id,purchase_id,qty,unit_price,expiry_date) VALUES(?,?,?,?,?)').run(id, pr, q, p, addDays(d));
      for (let k = 1; k <= 14; k++) db.prepare('INSERT INTO consumptions(food_id,qty,used_at) VALUES(?,?,?)').run(id, +(m * 0.4 * (0.6 + ((k * 7 + i) % 5) / 5)).toFixed(2), addDays(-k));
    });
    [['Milk', 2, 180, 20], ['Bread', 3, 150, 9], ['Chicken', 1, 220, 3], ['Tomato', 2, 120, 35]].forEach(([n, q, c, ago]) =>
      db.prepare('INSERT INTO waste(food_id,qty,cost,reason,wasted_at) SELECT id,?,?,?,? FROM foods WHERE name=?').run(q, c, 'expired', addDays(-ago), n));
  })();
  res.status(201).json({ seeded: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { if (!err.status) console.error(err); res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' }); });
app.listen(PORT, () => console.log(`FoodWise running on http://localhost:${PORT}`));
