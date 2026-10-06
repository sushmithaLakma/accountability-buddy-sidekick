import { openDatabase } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;

// DATABASE_URL (a Postgres connection string) is used when set — that's how
// the hosted version stores data. Otherwise a local SQLite file is used.
const db = await openDatabase({
  url: process.env.DATABASE_URL,
  file: process.env.DATABASE_FILE || 'data/accountability.db',
});

const app = createApp(db, {
  // Set SECURE_COOKIES=true when serving over HTTPS (you should in production).
  secureCookies: process.env.SECURE_COOKIES === 'true',
});
// Needed for correct client IPs (login rate limiting) behind a reverse proxy.
// A number means "trust this many proxy hops" (Render uses one).
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

app.listen(port, () => {
  console.log(`Accountability Buddy running at http://localhost:${port} (${db.kind} database)`);
});
