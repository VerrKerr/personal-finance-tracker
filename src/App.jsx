import { useEffect, useMemo, useState } from 'react';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

const formatCurrency = (value) => currencyFormatter.format(Number(value) || 0);

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.error || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) {
    return null;
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return response.json();
};

const initialForm = {
  type: 'expense',
  amount: '',
  category: '',
  date: formatDate(new Date()),
  note: ''
};

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('authToken') || '');
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState({ income: 0, expense: 0, balance: 0 });
  const [report, setReport] = useState({ period: 'month', buckets: [] });
  const [categories, setCategories] = useState([]);
  const [period, setPeriod] = useState('month');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState(null);

  const stats = useMemo(
    () => [
      { label: 'Income', value: summary.income, tone: 'positive' },
      { label: 'Expenses', value: summary.expense, tone: 'negative' },
      { label: 'Balance', value: summary.balance, tone: summary.balance >= 0 ? 'positive' : 'negative' }
    ],
    [summary]
  );

  const authFetch = (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetchJson(url, { ...options, headers });
  };

  const handleSignOut = async (silent = false) => {
    if (token && !silent) {
      try {
        await authFetch('/api/auth/logout', { method: 'POST' });
      } catch (logoutError) {
        // Ignore logout failures; we clear locally regardless.
      }
    }
    localStorage.removeItem('authToken');
    setToken('');
    setUser(null);
    setTransactions([]);
    setSummary({ income: 0, expense: 0, balance: 0 });
    setReport({ period: 'month', buckets: [] });
    setCategories([]);
    setForm(initialForm);
    setEditingId(null);
    setFormError('');
    setError('');
    setAuthForm({ username: '', password: '' });
    setAuthMode('login');
    setAuthError('');
  };

  const loadDashboard = async (nextPeriod = period) => {
    if (!token) {
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const [transactionsData, summaryData, reportData, categoryData] = await Promise.all([
        authFetch('/api/transactions?limit=50'),
        authFetch('/api/summary'),
        authFetch(`/api/report?period=${nextPeriod}&count=6`),
        authFetch('/api/categories')
      ]);

      setTransactions(transactionsData.transactions || []);
      setSummary(summaryData);
      setReport(reportData);
      setCategories(categoryData.categories || []);
    } catch (err) {
      if (err.status === 401) {
        await handleSignOut(true);
        setError('Session expired. Please sign in again.');
        return;
      }
      setError(err.message || 'Unable to load data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!token) {
      return;
    }

    const bootstrap = async () => {
      try {
        const data = await authFetch('/api/auth/me');
        setUser(data.user);
      } catch (err) {
        await handleSignOut(true);
      }
    };

    bootstrap();
  }, [token]);

  useEffect(() => {
    if (!token || !user) {
      return;
    }
    loadDashboard(period);
  }, [period, token, user]);

  const updateForm = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const updateAuthForm = (field) => (event) => {
    setAuthForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    try {
      const payload = {
        username: authForm.username.trim(),
        password: authForm.password
      };

      const data = await fetchJson(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!data?.token) {
        throw new Error('Unable to authenticate.');
      }

      localStorage.setItem('authToken', data.token);
      setToken(data.token);
      setUser(data.user);
      setAuthForm({ username: '', password: '' });
    } catch (err) {
      setAuthError(err.message || 'Unable to authenticate.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');

    if (!form.amount || Number(form.amount) <= 0) {
      setFormError('Enter a positive amount.');
      return;
    }

    if (!form.category.trim()) {
      setFormError('Category is required.');
      return;
    }

    if (!form.date) {
      setFormError('Date is required.');
      return;
    }

    try {
      const payload = {
        type: form.type,
        amount: Number(form.amount),
        category: form.category.trim(),
        date: form.date,
        note: form.note.trim()
      };

      if (editingId) {
        await authFetch(`/api/transactions/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        await authFetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      setForm({ ...initialForm, date: form.date, type: form.type });
      setEditingId(null);
      await loadDashboard(period);
    } catch (err) {
      if (err.status === 401) {
        await handleSignOut(true);
        setFormError('Session expired. Please sign in again.');
        return;
      }
      setFormError(err.message || 'Unable to save transaction.');
    }
  };

  const startEdit = (transaction) => {
    setEditingId(transaction.id);
    setForm({
      type: transaction.type,
      amount: String(transaction.amount ?? ''),
      category: transaction.category ?? '',
      date: transaction.date ?? formatDate(new Date()),
      note: transaction.note ?? ''
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(initialForm);
    setFormError('');
  };

  const handleDelete = async (transaction) => {
    const confirmed = window.confirm(
      `Delete ${transaction.type} of ${formatCurrency(transaction.amount)} in ${transaction.category}?`
    );

    if (!confirmed) {
      return;
    }

    try {
      await authFetch(`/api/transactions/${transaction.id}`, { method: 'DELETE' });
      await loadDashboard(period);
    } catch (err) {
      if (err.status === 401) {
        await handleSignOut(true);
        setError('Session expired. Please sign in again.');
        return;
      }
      setError(err.message || 'Unable to delete transaction.');
    }
  };

  if (!token || !user) {
    return (
      <div className="app auth">
        <header className="hero">
          <div>
            <p className="eyebrow">Personal Finance Tracker</p>
            <h1>Track income, expenses, and the story behind every dollar.</h1>
            <p className="subtitle">
              Sign in to start tracking, or create a new account to get started from scratch.
            </p>
          </div>
          <div className="auth-card">
            <div className="auth-toggle">
              <button
                type="button"
                className={authMode === 'login' ? 'active' : ''}
                onClick={() => {
                  setAuthMode('login');
                  setAuthError('');
                }}
              >
                Sign In
              </button>
              <button
                type="button"
                className={authMode === 'register' ? 'active' : ''}
                onClick={() => {
                  setAuthMode('register');
                  setAuthError('');
                }}
              >
                Create Account
              </button>
            </div>
            <form className="auth-form" onSubmit={handleAuthSubmit}>
              <label>
                Username
                <input
                  type="text"
                  autoComplete="username"
                  value={authForm.username}
                  onChange={updateAuthForm('username')}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                  value={authForm.password}
                  onChange={updateAuthForm('password')}
                />
              </label>
              {authError && <div className="form-error">{authError}</div>}
              <button className="primary" type="submit" disabled={authLoading}>
                {authLoading
                  ? 'Working...'
                  : authMode === 'login'
                    ? 'Sign In'
                    : 'Create Account'}
              </button>
            </form>
          </div>
        </header>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Personal Finance Tracker</p>
          <h1>Track income, expenses, and the story behind every dollar.</h1>
          <p className="subtitle">
            Capture daily transactions, assign categories, and watch your balance trend over time.
          </p>
          <div className="hero-actions">
            <span className="user-chip">Signed in as {user.username}</span>
            <button className="ghost" type="button" onClick={() => handleSignOut(false)}>
              Sign out
            </button>
          </div>
        </div>
        <div className="hero-card">
          <div className="hero-card__title">Current Balance</div>
          <div className="hero-card__value">{formatCurrency(summary.balance)}</div>
          <div className="hero-card__meta">Updated in real time</div>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      <section className="grid">
        {stats.map((stat) => (
          <div key={stat.label} className={`card stat ${stat.tone}`}>
            <div className="stat-label">{stat.label}</div>
            <div className="stat-value">{formatCurrency(stat.value)}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Spending vs Income</h2>
            <p>Compare recent performance across {period === 'month' ? 'months' : 'weeks'}.</p>
          </div>
          <div className="toggle">
            <button
              type="button"
              className={period === 'month' ? 'active' : ''}
              onClick={() => setPeriod('month')}
            >
              Monthly
            </button>
            <button
              type="button"
              className={period === 'week' ? 'active' : ''}
              onClick={() => setPeriod('week')}
            >
              Weekly
            </button>
          </div>
        </div>

        <div className="panel-body">
          <div className="legend">
            <span className="legend-item income">Income</span>
            <span className="legend-item expense">Expense</span>
          </div>
          <BarChart data={report.buckets || []} />
        </div>
      </section>

      <section className="panel two-col">
        <div className="panel-body">
          <h2>{editingId ? 'Edit Transaction' : 'Add Transaction'}</h2>
          <p>Log income or expenses with category and optional notes.</p>

          <form className="form" onSubmit={handleSubmit}>
            <label>
              Type
              <select value={form.type} onChange={updateForm('type')}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </label>

            <label>
              Amount
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={form.amount}
                onChange={updateForm('amount')}
              />
            </label>

            <label>
              Category
              <input
                list="category-list"
                placeholder="Groceries, Rent, Salary"
                value={form.category}
                onChange={updateForm('category')}
              />
            </label>
            <datalist id="category-list">
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>

            <label>
              Date
              <input type="date" value={form.date} onChange={updateForm('date')} />
            </label>

            <label className="full">
              Note
              <input
                type="text"
                placeholder="Optional note"
                value={form.note}
                onChange={updateForm('note')}
              />
            </label>

            {formError && <div className="form-error">{formError}</div>}

            <div className="form-actions">
              <button className="primary" type="submit">
                {editingId ? 'Update Transaction' : 'Save Transaction'}
              </button>
              {editingId ? (
                <button className="ghost" type="button" onClick={cancelEdit}>
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </div>

        <div className="panel-body">
          <div className="panel-header stack">
            <div>
              <h2>Recent Transactions</h2>
              <p>Latest 50 entries across all categories.</p>
            </div>
            {isLoading && <span className="pill">Loading...</span>}
          </div>

          <div className="table">
            <div className="table-row table-head">
              <span>Date</span>
              <span>Category</span>
              <span>Type</span>
              <span className="amount">Amount</span>
              <span className="actions">Actions</span>
            </div>
            {transactions.length === 0 && !isLoading ? (
              <div className="table-row empty">No transactions yet. Add one to get started.</div>
            ) : (
              transactions.map((transaction) => (
                <div className="table-row" key={transaction.id}>
                  <span>{transaction.date}</span>
                  <span>
                    <strong>{transaction.category}</strong>
                    {transaction.note ? <em>{transaction.note}</em> : null}
                  </span>
                  <span>
                    <span className={`badge ${transaction.type}`}>
                      {transaction.type === 'income' ? 'Income' : 'Expense'}
                    </span>
                  </span>
                  <span className="amount">
                    {formatCurrency(transaction.amount)}
                  </span>
                  <span className="actions">
                    <button type="button" className="link" onClick={() => startEdit(transaction)}>
                      Edit
                    </button>
                    <button type="button" className="link danger" onClick={() => handleDelete(transaction)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function BarChart({ data }) {
  if (!data.length) {
    return <div className="chart-empty">No data yet. Add transactions to see trends.</div>;
  }

  const maxValue = Math.max(
    1,
    ...data.map((item) => Math.max(item.income || 0, item.expense || 0))
  );

  return (
    <div className="chart">
      {data.map((item) => {
        const incomeWidth = Math.round((item.income / maxValue) * 100);
        const expenseWidth = Math.round((item.expense / maxValue) * 100);
        return (
          <div className="chart-row" key={item.label}>
            <div className="chart-label">{item.label}</div>
            <div className="chart-bars">
              <div className="chart-bar-row">
                <span className="chart-bar income" style={{ width: `${incomeWidth}%` }} />
                <span className="chart-value">{formatCurrency(item.income)}</span>
              </div>
              <div className="chart-bar-row">
                <span className="chart-bar expense" style={{ width: `${expenseWidth}%` }} />
                <span className="chart-value">{formatCurrency(item.expense)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default App;
