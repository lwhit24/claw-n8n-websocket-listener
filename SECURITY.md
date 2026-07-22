# Security Policy

## Supported versions

This project is intentionally small and deployment-driven. Use the latest `main` branch unless a release has been created.

## Reporting a vulnerability

Open a private security advisory on GitHub if available, or contact the repository maintainer privately.

Do not include real Claw API keys, n8n webhook secrets, phone numbers, message content or n8n execution screenshots in public issues.

## Operational guidance

- Keep `secrets/` and `.env` out of git.
- Use an allowlist in `ALLOWED_SENDERS`.
- Keep `ALLOW_GROUPS=false` unless explicitly required.
- Rotate the n8n webhook secret if it is ever exposed.
- Reduce or redact n8n execution data retention.
- Do not publish the listener container port. It should have no public ports.
