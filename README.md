# NovaSentinel 🛰️

Real-time space situational awareness: 3D Earth globe, conjunction risk assessment, and orbital decay prediction.

## Features

- **3D Interactive Globe** — Three.js WebGL scene with 8,000+ tracked objects as coloured point cloud
- **CDM Conjunction Alerts** — Real Space-Track CDM data, ML-scored, with CDM uncertainty ellipsoids
- **Brain.js LSTM Decay** — Sequence-based orbital decay prediction, reentry alert triage
- **TF.js PoC Inference** — 15-feature neural network for probability-of-collision scoring
- **Offline Support** — Service worker caches TLE/CDM data for operational continuity

---

## Quick Start

```bash
git clone https://github.com/eld-dlh/NovaSentinel.git
cd NovaSentinel
npm install
cp .env.example .env.local   # add credentials (see below)
npm run dev
```

Open http://localhost:5173

---

## Environment Variables

Create `.env.local` (never commit this):

```env
VITE_SPACETRACK_IDENTITY=your@email.com
VITE_SPACETRACK_PASSWORD=yourpassword
```

Without credentials, CDM panel is empty but TLE globe tracking works fully.

---

## Space-Track Account Setup

CDM access requires a **free** Space-Track account:

1. Register at https://www.space-track.org/auth/login
2. Select **Registered User** tier — approved within 24 hours
3. Accept the Terms of Service
4. Add credentials to `.env.local`

HTTPS is required by Space-Track. The Vite dev proxy (`/spacetrack/*`) handles this in development.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Vite dev server (localhost:5173) |
| `npm run build` | Production bundle → `/dist` |
| `npm test` | All 4 integration test suites |
| `npm run test:watch` | Re-run tests on file change |
| `npm run train` | Train TF.js PoC model offline |
| `npm run train-decay` | Train Brain.js LSTM offline |
| `npm run generate-data` | Fetch CDMs from Space-Track |

---

## Running Tests

Uses Node.js 18+ built-in test runner — no external framework:

```bash
npm test
```

Individual suites:

```bash
node --test tests/tleValidator.test.js
node --test tests/cdmCovariance.test.js
node --test tests/inference.test.js
node --test tests/pipeline.test.js
```

### Test Coverage

| Suite | What is tested |
|---|---|
| `tleValidator.test.js` | Checksum math, e=1.1 rejection, staleness, batch filter, audit log |
| `cdmCovariance.test.js` | Jacobi eigenvalues (known symmetric), trace invariant, axis bounds, perf |
| `inference.test.js` | Feature shape, all-finite, Spearman r ≥ 0.7 vs ground-truth PC, 8k perf |
| `pipeline.test.js` | Full parse→validate→SGP4→feature→covariance→decay-sequence chain |

Fixtures are deterministic — 3 CDMs spanning GREEN/AMBER/RED risk tiers with hand-computed expected eigenvalues.

---

## Deployment

### GitHub Pages (automatic)

Push to `main` → CI runs tests → deploys `/dist` to `gh-pages`.

Enable Pages: repo Settings → Pages → Source: **gh-pages** branch.

### Netlify

```toml
# netlify.toml
[build]
  command = "npm run build"
  publish = "dist"
```

Drop repo into Netlify — zero config.

### Vercel

```bash
npm i -g vercel && vercel --prod
```

---

## Content Security Policy

`public/_headers` (Netlify) sends:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  connect-src 'self' https://celestrak.org https://www.space-track.org;
  worker-src 'self' blob:;
```

`'wasm-unsafe-eval'` is required for TensorFlow.js and satellite.js WASM builds.

---

## Architecture

```
src/
├── data/           TLE parser, OMM fetch, CDM covariance, validator
├── propagation/    SGP4 Web Worker + batch propagator
├── ml/             TF.js PoC model + 15-feature normalisation
├── decay/          Brain.js LSTM + reentry alert engine
├── viz/            Three.js scene, Earth globe, point cloud, ellipsoids
├── ui/             Alert panel, decay panel, tooltip, CSV export
└── main.js         Orchestrator

tests/
├── fixtures/       3 ground-truth CDMs + TLE fixture with bad-checksum record
├── tleValidator.test.js
├── cdmCovariance.test.js
├── inference.test.js
└── pipeline.test.js

public/
├── sw.js           Service worker — offline TLE/CDM cache
└── _headers        Netlify CSP headers
```

---

## Performance Targets

| Metric | Target |
|---|---|
| TF.js batch inference 8k objects | < 500 ms (WebGL backend) |
| Three.js frame rate at 8k points | > 30 fps |
| CDM covariance + eigenvalue | < 5 ms / record |
| TLE parse + validate cycle | < 3 s |

---

## References

- Liu et al. — B* drag limitation in single-point PoC estimation
- ESA Collision Avoidance Challenge — 2,170 real CDMs (ML validation ground truth)
- McKnight et al. — 18th SCS operational PoC thresholds (1e-4 / 1e-3)
- Shigol et al. FRAME — model poisoning threat score 8.41/10 for space-surveillance ML

---

## License

ISC
