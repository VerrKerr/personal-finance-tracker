# Expense Tracker

A lightweight financial management web app built with React + Vite and backed by SQLite (via libSQL/Turso for deployment).

## Features
- Record income and expenses
- Category assignment with suggestions
- Balance and totals summary
- Weekly or monthly spending vs income report
- Visual chart for trends
- User accounts with per-user transactions

## Local setup

1. Set environment variables (local dev):

Create a `.env` file in the project root with:

```
TURSO_DATABASE_URL=your_turso_url
TURSO_AUTH_TOKEN=your_turso_auth_token
```

2. Install dependencies:

```bash
npm install
```

3. Run the client + API together:

```bash
npm run dev
```

- Vite dev server: http://localhost:5173
- API server: http://localhost:5174

The API requires a libSQL/Turso database URL and token (SQLite files are not persisted on Vercel).

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add environment variables in Vercel:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
3. Deploy.

## API quick reference

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/transactions?limit=50`
- `POST /api/transactions`
- `PUT /api/transactions/:id`
- `DELETE /api/transactions/:id`
- `GET /api/summary`
- `GET /api/report?period=month&count=6`
- `GET /api/categories`

## Scripts

- `npm run dev`: start Vite + API
- `npm run build`: build the frontend
- `npm run preview`: preview the build
- `npm run start`: run the API only
