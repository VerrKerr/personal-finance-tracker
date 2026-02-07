# Expense Tracker

A lightweight financial management web app built with React + Vite and backed by SQLite.

## Features
- Record income and expenses
- Category assignment with suggestions
- Balance and totals summary
- Weekly or monthly spending vs income report
- Visual chart for trends

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Run the client + API together:

```bash
npm run dev
```

- Vite dev server: http://localhost:5173
- API server: http://localhost:5174

The SQLite database is stored at `server/data/expense-tracker.db`.

## API quick reference

- `GET /api/transactions?limit=50`
- `POST /api/transactions`
- `GET /api/summary`
- `GET /api/report?period=month&count=6`
- `GET /api/categories`

## Scripts

- `npm run dev`: start Vite + API
- `npm run build`: build the frontend
- `npm run preview`: preview the build
- `npm run start`: run the API only
