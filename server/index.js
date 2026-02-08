import app, { dbReady } from './app.js';

const PORT = process.env.PORT || 5174;

dbReady
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Expense tracker API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
