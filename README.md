# Blueline

A free, open-source desktop app that reads and finishes HTML documents, especially the decks and
one-pagers that AI tools produce. Think Adobe Acrobat Reader, but for HTML.

- **Read:** open any `.html` file in a sandboxed, Chromium-exact view, with Protected view for files from others.
- **Review:** circle, highlight and pin; type, dictate or record notes that travel inside the file.
- **Edit:** click text and type; the change is written straight into the HTML, nothing else touched.
- **Hand off to Claude Code:** notes go to the agent as an anchored change list.

Status: **Phase 0 (spike)**. See [SPEC.md](SPEC.md) for the build spec, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for module boundaries, and [docs/PHASE0-FINDINGS.md](docs/PHASE0-FINDINGS.md) for what the spike settled.

Licensing is proposed and pending confirmation: see [LICENSING.md](LICENSING.md).
Never install or run Blueline through `npx blueline` (SPEC 9.5).
