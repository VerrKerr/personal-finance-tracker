import './env.js';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;

if (!url) {
  throw new Error('TURSO_DATABASE_URL is required. Set it in your environment.');
}

const authToken = process.env.TURSO_AUTH_TOKEN;

export const db = createClient({ url, authToken });

export async function initDb() {
  await db.execute('PRAGMA foreign_keys = ON');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.execute('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');

  const columns = await db.execute('PRAGMA table_info(transactions)');
  const hasUserId = columns.rows.some((column) => column.name === 'user_id');

  if (!hasUserId) {
    await db.execute('ALTER TABLE transactions ADD COLUMN user_id INTEGER');
  }
}
