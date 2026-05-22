# Contributing

Thanks for your interest in didww-voice-agent.

## Ground rules

- Open an issue before a large change so the approach can be agreed first.
- Keep the project **carrier-agnostic** where practical. DIDWW is the documented
  example; avoid hard-coding one carrier's quirks into the core call paths.
- Match the surrounding code style — ES modules, modern Node.js (>= 20), no
  build step, and comments that explain *why* rather than *what*.
- Never commit secrets. `.env` is git-ignored; keep it that way.
- Do not reintroduce private or branded values — real domains, real IPs, or
  internal service names. Use the documentation placeholders (`voice.example.com`,
  `203.0.113.10`).

## Development

The Node.js services live in `server/`. There is no build step.

```
cd server
npm ci
node --check agent.js      # syntax check
```

Running the full stack requires drachtio and rtpengine — see
[docs/QUICKSTART.md](docs/QUICKSTART.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
Signalling-only changes can be tested against a local drachtio; media changes
need a real call.

## Pull requests

- One logical change per pull request.
- Describe how you tested it. For call-path changes that means a **real test
  call** — say which carrier or softphone you used and what you observed.
- Update the relevant document under `docs/` in the same pull request.

## Reporting bugs

Use GitHub issues for bugs and feature requests. For security issues, follow
[SECURITY.md](SECURITY.md) instead — do not open a public issue.
