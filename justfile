# Harmony — local-first harmonic composition editor (Vite + Vitest + Playwright + Wrangler).
# Run `just` to list recipes. See README.md and the focused docs for product details.

set shell := ["sh", "-cu"]
set positional-arguments := true
set dotenv-load := true

dev_port := "5173"
preview_port := "4173"

[private]
default:
    @just --list

# ── setup ────────────────────────────────────────────────────────────

# Fresh clone → working dev env (deps + chromium for probes/shots)
[group('setup')]
setup: install browsers

# npm ci when lockfile exists, npm install otherwise
[group('setup')]
install:
    @if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Playwright Chromium (covers probes, shots, and fast e2e)
[group('setup')]
browsers:
    npx playwright install chromium

# Full Playwright browser matrix used by `just e2e` and `just ci`.
[group('setup')]
browsers-all:
    npx playwright install chromium firefox webkit

# Pre-flight: Node.js 22.12+, binaries, browsers
[group('setup')]
doctor:
    @node -e "const [m,j]=process.versions.node.split('.').map(Number); if (!(m>22 || (m===22 && j>=12))) { console.error('node '+process.versions.node+' < required 22.12+'); process.exit(1); } console.log('node', process.versions.node)"
    @command -v npm >/dev/null && echo "npm  $(npm --version)" || { echo "npm missing"; exit 1; }
    @command -v wrangler >/dev/null && echo "wrangler $(wrangler --version)" || echo "wrangler via npx (not global — fine)"
    @npx playwright --version
    @found=0; for cache in "${PLAYWRIGHT_BROWSERS_PATH:-}" "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright"; do if [ -n "$cache" ] && [ -d "$cache" ] && find "$cache" -maxdepth 1 -type d -name 'chromium-*' -print -quit | grep -q .; then found=1; break; fi; done; if [ "$found" -eq 1 ]; then echo "chromium present"; else echo "chromium missing — run: just browsers"; fi

# ── dev ──────────────────────────────────────────────────────────────

# Dev server → http://localhost:5173
[group('dev')]
dev:
    npm run dev -- --port {{ dev_port }} --strictPort

# Dev server reachable from LAN/devices (same port)
[group('dev')]
dev-host:
    npm run dev -- --port {{ dev_port }} --strictPort --host

# Typecheck + bundle to dist/
[group('dev')]
build:
    npm run build

# Serve production build → http://localhost:4173 (what e2e + deploy use)
[group('dev')]
preview:
    npx vite preview --port {{ preview_port }} --strictPort

# Run the canonical probe or another scripts/*.mjs file: `just probe probe.mjs`
[group('dev')]
probe file *args:
    @f="$1"; shift; [ -f "$f" ] || f="scripts/$f"; [ -f "$f" ] || { echo "no such file: $f (tried ./ and scripts/)"; exit 1; }; node "$f" "$@"

# UX review screenshots (requires `just dev` running on :5173)
[group('dev')]
shots:
    node scripts/ux-shots.mjs

# ── test ─────────────────────────────────────────────────────────────

# Vitest unit suites (domain, state, persistence, audio, midi); `just test lanes`
[group('test')]
test *args:
    npm test -- "$@"

# Vitest in watch mode
[group('test')]
test-watch:
    npx vitest

# Full e2e matrix (chromium+firefox+webkit, builds first per playwright.config.ts)
[group('test')]
e2e *args:
    npx playwright test "$@"

# Fast single-browser pass for local iteration
[group('test')]
e2e-chromium *args:
    npx playwright test --project=chromium "$@"

# E2E with visible browser (debugging selectors/timing)
[group('test')]
e2e-headed *args:
    npx playwright test --project=chromium --headed "$@"

# Playwright inspector / HTML report
[group('test')]
e2e-ui *args:
    npx playwright test --ui "$@"

# ── quality ──────────────────────────────────────────────────────────

# tsc --noEmit
[group('quality')]
typecheck:
    npm run typecheck

# eslint, zero warnings allowed
[group('quality')]
lint:
    npm run lint

# Autofix lint findings in place
[group('quality')]
fix:
    npx eslint . --fix

# Pre-push gate (per README house rules): typecheck + lint + unit
[group('quality')]
check: typecheck lint test

# What CI runs: check + full e2e matrix with retries
[group('quality')]
ci: typecheck lint test
    CI=1 npx playwright test

# Show outdated deps
[group('quality')]
outdated:
    npm outdated || test $? -eq 1

# clean + node_modules (fresh-clone state; asks first)
[confirm("delete node_modules and start from a fresh clone state?")]
[group('clean')]
scrub: clean
    rm -rf node_modules

# Build + deploy static Worker (single build, no double-build via npm script)
[group('deploy')]
deploy: build
    npx wrangler deploy

# Validate deploy config without publishing
[group('deploy')]
deploy-dry: build
    npx wrangler deploy --dry-run

# ── clean ────────────────────────────────────────────────────────────

# Remove build output and test artifacts
[group('clean')]
clean:
    rm -rf dist playwright-report test-results .ux-shots
