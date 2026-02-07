import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import db from './db.js';

const app = express();
const PORT = process.env.PORT || 5174;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const allowedTypes = new Set(['income', 'expense']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function isValidDate(value) {
  return typeof value === 'string' && datePattern.test(value);
}

function isValidAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

function buildRangeFilter({ start, end, userId }) {
  const clauses = ['user_id = ?'];
  const params = [userId];

  if (start && isValidDate(start)) {
    clauses.push('date >= ?');
    params.push(start);
  }

  if (end && isValidDate(end)) {
    clauses.push('date <= ?');
    params.push(end);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== candidate.length) {
    return false;
  }
  return crypto.timingSafeEqual(stored, candidate);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, userId, expiresAt);

  return { token, expiresAt };
}

function getToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const session = db
    .prepare(
      `SELECT sessions.token, sessions.user_id, sessions.expires_at, users.username
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`
    )
    .get(token);

  if (!session) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  if (new Date(session.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired.' });
  }

  req.user = { id: session.user_id, username: session.username };
  req.sessionToken = token;
  return next();
}

function parseISODate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfWeek(date) {
  const copy = new Date(date);
  const weekday = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - weekday);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = typeof username === 'string' ? username.trim() : '';

  if (cleanUsername.length < 3 || cleanUsername.length > 30) {
    return res.status(400).json({ error: 'Username must be 3-30 characters.' });
  }

  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const existing = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(cleanUsername);

  if (existing) {
    return res.status(409).json({ error: 'Username is already taken.' });
  }

  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)'
    )
    .run(cleanUsername, hash, salt);

  const session = createSession(info.lastInsertRowid);

  return res.status(201).json({
    token: session.token,
    user: { id: info.lastInsertRowid, username: cleanUsername }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = typeof username === 'string' ? username.trim() : '';

  if (!cleanUsername || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = db
    .prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ?')
    .get(cleanUsername);

  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const session = createSession(user.id);

  return res.json({
    token: session.token,
    user: { id: user.id, username: user.username }
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  return res.status(204).send();
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

app.get('/api/transactions', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { start, end } = req.query;
  const { where, params } = buildRangeFilter({ start, end, userId: req.user.id });

  const rows = db
    .prepare(
      `SELECT id, type, amount, category, date, note
       FROM transactions
       ${where}
       ORDER BY date DESC, id DESC
       LIMIT ?`
    )
    .all(...params, limit);

  res.json({ transactions: rows });
});

app.get('/api/categories', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT category
       FROM transactions
       WHERE user_id = ?
       ORDER BY category COLLATE NOCASE`
    )
    .all(req.user.id);

  res.json({ categories: rows.map((row) => row.category) });
});

app.post('/api/transactions', requireAuth, (req, res) => {
  const { type, amount, category, date, note } = req.body || {};

  if (!allowedTypes.has(type)) {
    return res.status(400).json({ error: 'Type must be income or expense.' });
  }

  if (!isValidAmount(amount)) {
    return res.status(400).json({ error: 'Amount must be a positive number.' });
  }

  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: 'Category is required.' });
  }

  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  }

  const cleanCategory = category.trim();
  const cleanNote = typeof note === 'string' ? note.trim() : '';

  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, type, amount, category, date, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, type, Number(amount), cleanCategory, date, cleanNote || null);

  const created = db
    .prepare(
      `SELECT id, type, amount, category, date, note
       FROM transactions
       WHERE id = ? AND user_id = ?`
    )
    .get(info.lastInsertRowid, req.user.id);

  return res.status(201).json({ transaction: created });
});

app.put('/api/transactions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { type, amount, category, date, note } = req.body || {};

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' });
  }

  if (!allowedTypes.has(type)) {
    return res.status(400).json({ error: 'Type must be income or expense.' });
  }

  if (!isValidAmount(amount)) {
    return res.status(400).json({ error: 'Amount must be a positive number.' });
  }

  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: 'Category is required.' });
  }

  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  }

  const cleanCategory = category.trim();
  const cleanNote = typeof note === 'string' ? note.trim() : '';

  const result = db
    .prepare(
      `UPDATE transactions
       SET type = ?, amount = ?, category = ?, date = ?, note = ?
       WHERE id = ? AND user_id = ?`
    )
    .run(type, Number(amount), cleanCategory, date, cleanNote || null, id, req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Transaction not found.' });
  }

  const updated = db
    .prepare(
      `SELECT id, type, amount, category, date, note
       FROM transactions
       WHERE id = ? AND user_id = ?`
    )
    .get(id, req.user.id);

  return res.json({ transaction: updated });
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' });
  }

  const result = db
    .prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?')
    .run(id, req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Transaction not found.' });
  }

  return res.status(204).send();
});

app.get('/api/summary', requireAuth, (req, res) => {
  const { start, end } = req.query;
  const { where, params } = buildRangeFilter({ start, end, userId: req.user.id });

  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
       FROM transactions
       ${where}`
    )
    .get(...params);

  const income = Number(row.income || 0);
  const expense = Number(row.expense || 0);

  res.json({
    income,
    expense,
    balance: income - expense
  });
});

app.get('/api/report', requireAuth, (req, res) => {
  const period = req.query.period === 'week' ? 'week' : 'month';
  const count = Math.min(Math.max(Number(req.query.count) || 6, 2), 24);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let buckets = [];
  let rangeStart;
  let rangeEnd;

  if (period === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth() - (count - 1), 1);
    rangeStart = start;
    const lastBucket = new Date(today.getFullYear(), today.getMonth(), 1);
    rangeEnd = new Date(lastBucket.getFullYear(), lastBucket.getMonth() + 1, 0);

    for (let i = 0; i < count; i += 1) {
      const current = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
      buckets.push({
        key,
        label: `${months[current.getMonth()]} ${String(current.getFullYear()).slice(2)}`,
        income: 0,
        expense: 0
      });
    }
  } else {
    const endWeekStart = startOfWeek(today);
    const start = addDays(endWeekStart, -(count - 1) * 7);
    rangeStart = start;
    rangeEnd = addDays(endWeekStart, 6);

    for (let i = 0; i < count; i += 1) {
      const current = addDays(start, i * 7);
      const key = formatDate(current);
      buckets.push({
        key,
        label: `${months[current.getMonth()]} ${String(current.getDate()).padStart(2, '0')}`,
        income: 0,
        expense: 0
      });
    }
  }

  const rows = db
    .prepare(
      `SELECT date, type, amount
       FROM transactions
       WHERE user_id = ? AND date >= ? AND date <= ?`
    )
    .all(req.user.id, formatDate(rangeStart), formatDate(rangeEnd));

  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  rows.forEach((row) => {
    const transactionDate = parseISODate(row.date);

    let key;
    if (period === 'month') {
      key = row.date.slice(0, 7);
    } else {
      key = formatDate(startOfWeek(transactionDate));
    }

    const bucket = bucketMap.get(key);
    if (!bucket) {
      return;
    }

    if (row.type === 'income') {
      bucket.income += row.amount;
    } else {
      bucket.expense += row.amount;
    }
  });

  res.json({
    period,
    count,
    start: formatDate(rangeStart),
    end: formatDate(rangeEnd),
    buckets
  });
});

app.listen(PORT, () => {
  console.log(`Expense tracker API listening on http://localhost:${PORT}`);
});
