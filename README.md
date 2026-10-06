# Accountability Buddy (sidekick)

Helps people keep focus so they progress as they are meant to.

Pair up with an accountability partner anywhere in the world. You each share
your goals for the week and the month, plan what you'll do (and decide) each
day, and check in on each other on a schedule you agree on.

## Features

- **Accounts:** sign up with a username and password. Your timezone is detected at sign-up and can be changed in Settings.
- **Partners:** send a request by username. The other person accepts or declines. You can have more than one partner, and either side can end a partnership. If you both request each other, the partnership becomes active.
- **Goals:** weekly and monthly goals, for this period or the next one. Each goal has optional details, a 0–100% progress slider, and can be marked done, dropped or reopened. Past goals stay viewable.
- **Today:** a daily list of to-dos and *decisions*, optionally linked to a goal. You can browse other days and plan ahead. A "bring over unfinished items" button copies what you didn't finish onto today, and the original day keeps its record.
- **Timezones:** "today" always means *your* calendar day. Your partner sees your plan for your day, plus your local time.
- **Check-ins:** each partnership has a check-in interval (every day, 2 days, 3 days, week or 2 weeks). A check-in has a mood (1–5) plus *what went well*, *what got in the way* and *what's next*. The app shows when your check-in is due, and whether your partner is overdue. Due check-ins show up as a badge in the nav and a notice on the Today page.
- **Catch up:** a chat thread per partnership. The partner page refreshes every 15 seconds.
- **Privacy:** a partner's goals, plans, check-ins and messages are only visible while the partnership is active.

## Put it online (no installs needed)

The app runs on **Render** (hosting, free plan) and stores data in **Neon**
(Postgres database, free plan). Everything is done in the browser. You get a
link like `https://accountability-buddy-xxxx.onrender.com` to share with your
partner.

> Free-plan terms change. As of October 2026, here's what search results say. Please confirm on each provider's pricing page:
> - Render's free web services sleep after about 15 minutes without visitors, and the first visit afterwards takes up to about a minute to load.
> - Render may ask for a card to verify your account.
> - Neon's free plan is not time-limited and includes 0.5 GB of storage, which is plenty for this app.

**1. Create the database (Neon)**
1. Go to https://neon.tech and sign up (you can use your GitHub or Google account).
2. Create a project (any name, pick the region closest to you).
3. Copy the project's connection string (on the project dashboard, usually under **Connect** or **Connection details**). It starts with `postgresql://` and ends with `?sslmode=require`. Keep it secret: it works like a password.

**2. Deploy the app (Render)**
1. Go to https://render.com and sign up with your GitHub account.
2. Click **New → Blueprint**, and give Render access to this repository if it asks.
3. Choose this repository (and the branch that contains `render.yaml`).
4. When asked for `DATABASE_URL`, paste the Neon connection string. Then click **Apply** / **Deploy**.
5. Wait for the deploy to finish (a few minutes). Open the `onrender.com` link shown on the service page.

**3. Start using it**
Sign up, then send the link to your partner. Once they've signed up too, invite them from the **Partners** tab using their username.

New commits to the deployed branch are redeployed automatically.

## Try it without deploying (GitHub Codespaces)

On the repository page on GitHub, click **Code → Codespaces → Create codespace**.
The app installs and starts by itself, and opens in a browser tab. This is only
for trying the app: codespaces stop when idle.

## Running it on your own computer (optional)

Requires **Node.js 22.5+**. Without `DATABASE_URL`, it uses Node's built-in SQLite (`node:sqlite`, still marked experimental) and saves data to a local file.

```bash
npm install
npm start            # http://localhost:3000
npm test             # API tests (in-memory SQLite)
TEST_DATABASE_URL=postgres://... npm test   # same tests on Postgres (wipes that database!)
```

Configuration (environment variables):

| Variable         | Default                     | Purpose                                                       |
| ---------------- | --------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`   | unset                       | Postgres connection string; when set, SQLite is not used      |
| `DATABASE_FILE`  | `data/accountability.db`    | SQLite file used when `DATABASE_URL` is unset                 |
| `PORT`           | `3000`                      | HTTP port                                                     |
| `SECURE_COOKIES` | unset                       | Set to `true` when served over HTTPS                          |
| `TRUST_PROXY`    | unset                       | Express `trust proxy` (e.g. `1` behind one proxy, as on Render) |

## How it's built

- `src/app.js` — Express 5 JSON API (`/api/...`) and static file serving
- `src/db.js` — schema and a small async database layer (Postgres or SQLite)
- `src/dates.js` — timezone-aware calendar helpers
- `src/auth.js` — scrypt password hashing, session tokens (only hashes are stored)
- `public/` — dependency-free single-page frontend (no build step)
- `render.yaml` — Render deployment settings; `.devcontainer/` — Codespaces setup

Security notes:
- Sessions use HttpOnly, SameSite=Lax cookies.
- State-changing requests must be JSON, which blocks cross-site form posts.
- Repeated failed logins are rate limited in memory, per IP and username.
- A strict Content-Security-Policy is set, and all user text is rendered as text nodes.

## Not included yet

- Email or push reminders when a check-in is due. Reminders only show inside the app.
- Password reset and real-time updates (the partner page polls instead).
