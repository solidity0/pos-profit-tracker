# Ledger tests

These tests run the real app and the real security rules (`../firestore.rules`) against
**local Firebase emulators**. They never touch the live database, so they're safe to run any
time, and they wipe the emulator's data at the start of each run.

| File | What it checks |
| --- | --- |
| `rules-test.mjs` | The security rules: each business's data stays private, salespeople can only do what they're allowed, suspensions, usernames, email confirmation for new owners. |
| `e2e.js` | The whole app in a phone-sized browser: signing in as owner or salesperson, logging and deleting, offline logging, the team, reports, PDF, Excel/CSV and backup downloads, wrong phone clocks, sign-up with email confirmation, suspension, legal pages. |
| `pwa.js` | The installed app: it has a manifest and icons, and once loaded it opens and works with no internet, then uploads when the connection is back. |
| `emulator.cjs` | Shared helpers: reset the emulators, seed data, open email-confirmation links. |

## Run them

You need Node.js 20 or newer, Java 11 or newer (for the Firestore emulator) and Python 3
(to serve the app locally).

```bash
cd tests
npm install
npx playwright install chromium   # first time only
./run.sh                          # everything
./run.sh rules                    # or one part: rules, e2e, pwa
```

`run.sh` serves the app at http://127.0.0.1:8000, starts the Auth and Firestore emulators,
runs the tests and stops everything afterwards. Each line prints `PASS` or `FAIL`, and a run
ends with `ALL PASSED` (or `N passed, 0 failed` for the rules). Screenshots go in `tests/out/`.

The browser tests open the app with `?emulator=1`, which points it at the emulators instead of
the live project. The Firebase SDK and jsPDF are served from `node_modules` rather than the
internet.

## After changing the rules

Run `./run.sh rules`, then paste `firestore.rules` into Firebase console → Firestore Database
→ Rules and press **Publish**. The live app only follows the rules once they're published.
