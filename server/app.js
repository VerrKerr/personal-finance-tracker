import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { db, initDb } from './db.js';

const app = express();
const dbReady = initDb();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use(async (req, res, next) => {
  try {
    await dbReady;
    return next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database unavailable.' });
  }
});

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

function getRowsAffected(result) {
  return Number(result.rowsAffected ?? result.rows_affected ?? result.changes ?? 0);
}

function getLastInsertId(result) {
  return Number(result.lastInsertRowid ?? result.last_insert_rowid ?? 0);
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

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await db.execute({
    sql: 'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    args: [token, userId, expiresAt]
  });

  return { token, expiresAt };
}

function getToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const sessionResult = await db.execute({
      sql: `
        SELECT sessions.token, sessions.user_id, sessions.expires_at, users.username
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ?
      `,
      args: [token]
    });

    const session = sessionResult.rows[0];

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    if (new Date(session.expires_at) <= new Date()) {
      await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
      return res.status(401).json({ error: 'Session expired.' });
    }

    req.user = { id: Number(session.user_id), username: session.username };
    req.sessionToken = token;
    return next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to authenticate.' });
  }
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

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const cleanUsername = typeof username === 'string' ? username.trim() : '';

    if (cleanUsername.length < 3 || cleanUsername.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters.' });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = await db.execute({
      sql: 'SELECT id FROM users WHERE username = ?',
      args: [cleanUsername]
    });

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const { salt, hash } = hashPassword(password);
    const info = await db.execute({
      sql: 'INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)',
      args: [cleanUsername, hash, salt]
    });

    const userId = getLastInsertId(info);
    const session = await createSession(userId);

    return res.status(201).json({
      token: session.token,
      user: { id: userId, username: cleanUsername }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to register.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const cleanUsername = typeof username === 'string' ? username.trim() : '';

    if (!cleanUsername || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const userResult = await db.execute({
      sql: 'SELECT id, username, password_hash, password_salt FROM users WHERE username = ?',
      args: [cleanUsername]
    });

    const user = userResult.rows[0];

    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const session = await createSession(Number(user.id));

    return res.json({
      token: session.token,
      user: { id: Number(user.id), username: user.username }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to sign in.' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [req.sessionToken] });
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to sign out.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { start, end } = req.query;
    const { where, params } = buildRangeFilter({ start, end, userId: req.user.id });

    const result = await db.execute({
      sql: `
        SELECT id, type, amount, category, date, note
        FROM transactions
        ${where}
        ORDER BY date DESC, id DESC
        LIMIT ?
      `,
      args: [...params, limit]
    });

    res.json({ transactions: result.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to fetch transactions.' });
  }
});

app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `
        SELECT DISTINCT category
        FROM transactions
        WHERE user_id = ?
        ORDER BY category COLLATE NOCASE
      `,
      args: [req.user.id]
    });

    res.json({ categories: result.rows.map((row) => row.category) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to fetch categories.' });
  }
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  try {
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

    const insertResult = await db.execute({
      sql: `
        INSERT INTO transactions (user_id, type, amount, category, date, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [req.user.id, type, Number(amount), cleanCategory, date, cleanNote || null]
    });

    const createdResult = await db.execute({
      sql: `
        SELECT id, type, amount, category, date, note
        FROM transactions
        WHERE id = ? AND user_id = ?
      `,
      args: [getLastInsertId(insertResult), req.user.id]
    });

    return res.status(201).json({ transaction: createdResult.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to save transaction.' });
  }
});

app.put('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
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

    const updateResult = await db.execute({
      sql: `
        UPDATE transactions
        SET type = ?, amount = ?, category = ?, date = ?, note = ?
        WHERE id = ? AND user_id = ?
      `,
      args: [type, Number(amount), cleanCategory, date, cleanNote || null, id, req.user.id]
    });

    const rowsAffected = getRowsAffected(updateResult);
    if (rowsAffected === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const updatedResult = await db.execute({
      sql: `
        SELECT id, type, amount, category, date, note
        FROM transactions
        WHERE id = ? AND user_id = ?
      `,
      args: [id, req.user.id]
    });

    return res.json({ transaction: updatedResult.rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to update transaction.' });
  }
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid transaction id.' });
    }

    const deleteResult = await db.execute({
      sql: 'DELETE FROM transactions WHERE id = ? AND user_id = ?',
      args: [id, req.user.id]
    });

    const rowsAffected = getRowsAffected(deleteResult);
    if (rowsAffected === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to delete transaction.' });
  }
});

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const { where, params } = buildRangeFilter({ start, end, userId: req.user.id });

    const result = await db.execute({
      sql: `
        SELECT
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
        FROM transactions
        ${where}
      `,
      args: params
    });

    const row = result.rows[0] || { income: 0, expense: 0 };
    const income = Number(row.income || 0);
    const expense = Number(row.expense || 0);

    res.json({
      income,
      expense,
      balance: income - expense
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to fetch summary.' });
  }
});

app.get('/api/report', requireAuth, async (req, res) => {
  try {
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

    const rowsResult = await db.execute({
      sql: `
        SELECT date, type, amount
        FROM transactions
        WHERE user_id = ? AND date >= ? AND date <= ?
      `,
      args: [req.user.id, formatDate(rangeStart), formatDate(rangeEnd)]
    });

    const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

    rowsResult.rows.forEach((row) => {
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
        bucket.income += Number(row.amount);
      } else {
        bucket.expense += Number(row.amount);
      }
    });

    res.json({
      period,
      count,
      start: formatDate(rangeStart),
      end: formatDate(rangeEnd),
      buckets
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unable to generate report.' });
  }
});

export { dbReady };
export default app;
