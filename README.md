# road-trip-agent

An AI road-trip coordinator that lives in your iMessage group chat (HackNC 2026). Plan in the chat → decide together in a Photon miniapp → follow and revise the trip on a shared map.

**Status:** capability spike — verifying Photon Spectrum group-chat support before building the planner. See [`docs/photon-probe.md`](docs/photon-probe.md).

## Quick start

```sh
nvm use            # Node 24
npm install
cp .env.example .env   # fill SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET for the probe
npm run dev        # server :8787 + miniapp :5173
npm run probe      # Photon capability probe
npm test && npm run typecheck && npm run lint
```

- Build contract: [`docs/spec.md`](docs/spec.md)
- Contributor/agent guide: [`CLAUDE.md`](CLAUDE.md)
