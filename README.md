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

## Running it

Requires **Node.js 22.5+**. It uses the built-in `node:sqlite` module, which is still marked experimental.

```bash
npm install
npm start            # http://localhost:3000
npm test             # API tests (node:test)
```

Configuration (environment variables):

| Variable         | Default                     | Purpose                                                     |
| ---------------- | --------------------------- | ----------------------------------------------------------- |
| `PORT`           | `3000`                      | HTTP port                                                   |
| `DATABASE_FILE`  | `data/accountability.db`    | SQLite database file                                        |
| `SECURE_COOKIES` | unset                       | Set to `true` when served over HTTPS                        |
| `TRUST_PROXY`    | unset                       | Express `trust proxy` setting when behind a reverse proxy   |

To let people "anywhere in the world" connect, deploy it to any host that runs
Node and gives you a persistent disk for the SQLite file. Serve it over HTTPS
and set `SECURE_COOKIES=true`.

## How it's built

- `src/app.js` — Express 5 JSON API (`/api/...`) and static file serving
- `src/db.js` — SQLite schema
- `src/dates.js` — timezone-aware calendar helpers
- `src/auth.js` — scrypt password hashing, session tokens (only hashes are stored)
- `public/` — dependency-free single-page frontend (no build step)

Security notes:
- Sessions use HttpOnly, SameSite=Lax cookies.
- State-changing requests must be JSON, which blocks cross-site form posts.
- Repeated failed logins are rate limited in memory, per IP and username.
- A strict Content-Security-Policy is set, and all user text is rendered as text nodes.

## Not included yet

- Email or push reminders when a check-in is due. Reminders only show inside the app.
- Password reset and real-time updates (the partner page polls instead).
