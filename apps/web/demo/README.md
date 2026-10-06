# Single-file demo

`vitral-demo.html` is the whole web app in one file that opens from disk (double-click), for reviewing screens
without a server. API reads are answered from responses recorded on a real server with sample data; writes show
«این نسخه‌ی نمایشی است؛ تغییرات ذخیره نمی‌شود».

1. Seed a database (e.g. run `test/golden.test.ts` against it) and start the Node server on it (port 3100).
2. `DEMO_URL=http://localhost:3100 DEMO_MOBILE=… DEMO_PASSWORD=… node apps/web/demo/record.mjs demo-data.json`
3. `node apps/web/demo/build.mjs demo-data.json vitral-demo.html`

The web app switches to this mode only when built with `VITE_DEMO=1` (`src/demo.ts`: hash routing, fetch/window.open
answered from the embedded data, a «نسخه‌ی نمایشی» banner).
