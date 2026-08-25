# STATS 401 Labs

> **Created with [Claude Code](https://claude.com/product/claude-code).**
> The project structure, multi-page Vite configuration, GitHub Actions
> deployment workflow, and per-lab placeholder modules in this
> repository were bootstrapped in collaboration with Claude Code (the
> `claude` CLI). These serves as a starting template only — the lab implementations
> are by myself.

STATS 401: Data Acquisition and Visualization — Lab 1–10 site, built
with **Vite** + **D3.js** and deployed via **GitHub Pages**.

## Project structure

```
stats401-labs/
├── .github/workflows/deploy.yml   # GitHub Actions → GitHub Pages
├── public/
│   └── data/                      # Copied verbatim into dist/data/ at build
│       ├── students.csv           # Assignment dataset (8 students)
│       └── students.json
├── src/                           # All authored JS / CSS; bundled by Vite
│   ├── main.js                    # Homepage entry
│   ├── labs/
│   │   ├── nav.js                 # Shared navigation bar helper
│   │   ├── lab1.js                # Lab 1 ES-module entry (D3 demo)
│   │   └── lab2.js … lab10.js     # Placeholder entries (one per lab)
│   └── styles/
│       └── main.css               # Global styles + .lab-nav rules
├── index.html                     # Homepage Vite entry
├── lab1/index.html … lab10/index.html   # Per-lab Vite entries
├── package.json
├── vite.config.js                 # Multi-page config, base: '/stats401-labs/'
└── README.md
```

### How the pieces fit together

- **Vite multi-page build.** Each `index.html` is listed in
  `vite.config.js → build.rollupOptions.input`. Vite emits one hashed
  JS bundle per entry, sharing chunks where it can.
- **`base: '/stats401-labs/'`.** Because this is a *project* repo
  (not a user/org page at the domain root), every asset URL Vite
  generates is prefixed with `/stats401-labs/`. Without this, the
  deployed site 404s on every asset.
- **`public/` is copied verbatim** into `dist/` at build time, so
  `public/data/students.csv` is served at
  `/stats401-labs/data/students.csv` on GitHub Pages — exactly what
  `d3.csv('/stats401-labs/data/students.csv')` needs.
- **Shared nav.** Every page has `<div id="nav"></div>` and its entry
  JS calls `mountNav('#nav')` from `src/labs/nav.js`. Editing the nav
  in one place updates all 11 pages.

## Dev commands

```bash
npm install        # one-time: installs vite + d3 (creates package-lock.json)
npm run dev        # Vite dev server at http://localhost:5173/stats401-labs/
npm run build      # production build → dist/
npm run preview    # serve the built dist/ at http://localhost:4173/stats401-labs/
```

The `/stats401-labs/` path is intentional — Vite is configured to use
that subpath in both dev and preview so the experience matches the
deployed GitHub Pages URL exactly.

## Adding a new lab (or replacing a placeholder)

1. Create `labN/index.html` (copy a placeholder template; update the
   `<title>`, `<h1>`, and the `<script type="module">` path to point
   at `/src/labs/labN.js`).
2. Author `src/labs/labN.js`:
   ```js
   import * as d3 from 'd3';
   import { mountNav } from './nav.js';
   import '../styles/main.css';

   mountNav('#nav');

   // …your D3 visualization code…
   ```
3. Add the new entry to `vite.config.js → build.rollupOptions.input`
   (the list of `labN: resolve(__dirname, 'labN/index.html')` entries).
4. The nav automatically picks up labs 1–10 from `src/labs/nav.js`
   (it generates them programmatically), so no nav edit is needed.

## Deploying

Every push to `main` runs `.github/workflows/deploy.yml`, which:

1. Runs `npm ci` (uses the committed `package-lock.json`).
2. Runs `npm run build` to produce `dist/`.
3. Uploads `dist/` as the GitHub Pages artifact.
4. Deploys the artifact via `actions/deploy-pages@v4`.

### One-time repo setting

GitHub → **Settings → Pages → Build and deployment → Source: GitHub
Actions**. (Not "Deploy from a branch" — that mode ignores the
workflow artifact.)

After the workflow succeeds, the site is live at:

```
https://<your-github-username>.github.io/stats401-labs/
https://<your-github-username>.github.io/stats401-labs/lab1/
…
https://<your-github-username>.github.io/stats401-labs/lab10/
```

## Where data lives

- `public/data/*` is copied verbatim into `dist/data/*` at build
  time.
- At runtime on GitHub Pages, files are served from
  `/stats401-labs/data/...`. Use the absolute path inside D3 so it
  works regardless of which lab page is loading it:
  ```js
  d3.csv(`${import.meta.env.BASE_URL}data/students.csv`)
  ```

## Re-bolting this template later

If you ever want to re-generate or extend this scaffolding with
Claude Code, ask it to read `README.md` and `vite.config.js` first
so it picks up the conventions you've established here.