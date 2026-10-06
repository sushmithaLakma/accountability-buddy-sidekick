import { openDatabase } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DATABASE_FILE || 'data/accountability.db';

const app = createApp(openDatabase(dbFile), {
  // Set SECURE_COOKIES=true when serving over HTTPS (you should in production).
  secureCookies: process.env.SECURE_COOKIES === 'true',
});
// Needed for correct client IPs (login rate limiting) behind a reverse proxy.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.listen(port, () => {
  console.log(`Accountability Buddy running at http://localhost:${port}`);
});
