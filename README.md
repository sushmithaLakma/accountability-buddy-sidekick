# accountability-buddy-sidekick
Helps people keep focus so they progress as they are meant to

## What it does

A small daily planner that turns "things I want to do today" into steps small enough to start.

- **Add a goal** for the day and break it into smaller steps (one per line; add `| 15` to estimate 15 minutes).
- **Progress status** for every step and goal: Not started → In progress → Done, with a progress bar and minutes left.
- **Time to start**: each step records when it was added and when you started it, so you can see how long it sat before you got going ("Took 12m to start"). Waiting steps show a live "waiting 40m" counter.
- **Time spent** vs. your estimate (shown in red when you run over).
- **Next small step** banner always points at the one thing to do now, and turns amber if it has waited more than 30 minutes.
- **Day summary**: goals done, steps done, average time to start, time on tasks.
- Move between days, and bring unfinished goals forward from a previous day.
- Export/import your data as JSON.

## Running it

No install or build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Data is stored in your browser's `localStorage`, so it stays on that device and browser only. Use Export to back it up.
