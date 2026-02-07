import express from 'express';
import cors from 'cors';
import db from './db.js';

const app = express();
const PORT = process.env.PORT || 5174;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const allowedTypes = new Set(['income', 'expense']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  return typeof value === 'string' && datePattern.test(value);
}

function isValidAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

function buildRangeFilter({ start, end }) {
  const clauses = [];
  const params = [];

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

app.get('/api/transactions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { start, end } = req.query;
  const { where, params } = buildRangeFilter({ start, end });

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

app.get('/api/categories', (req, res) => {
  const rows = db
    .prepare(`SELECT DISTINCT category FROM transactions ORDER BY category COLLATE NOCASE`)
    .all();

  res.json({ categories: rows.map((row) => row.category) });
});

app.post('/api/transactions', (req, res) => {
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
      `INSERT INTO transactions (type, amount, category, date, note)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(type, Number(amount), cleanCategory, date, cleanNote || null);

  const created = db
    .prepare(
      `SELECT id, type, amount, category, date, note
       FROM transactions
       WHERE id = ?`
    )
    .get(info.lastInsertRowid);

  return res.status(201).json({ transaction: created });
});

app.put('/api/transactions/:id', (req, res) => {
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
       WHERE id = ?`
    )
    .run(type, Number(amount), cleanCategory, date, cleanNote || null, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Transaction not found.' });
  }

  const updated = db
    .prepare(
      `SELECT id, type, amount, category, date, note
       FROM transactions
       WHERE id = ?`
    )
    .get(id);

  return res.json({ transaction: updated });
});

app.delete('/api/transactions/:id', (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid transaction id.' });
  }

  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Transaction not found.' });
  }

  return res.status(204).send();
});

app.get('/api/summary', (req, res) => {
  const { start, end } = req.query;
  const { where, params } = buildRangeFilter({ start, end });

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

app.get('/api/report', (req, res) => {
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
       WHERE date >= ? AND date <= ?`
    )
    .all(formatDate(rangeStart), formatDate(rangeEnd));

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
