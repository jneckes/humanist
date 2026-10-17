# Motion fixtures

Review and Edit render a deck with `prefers-reduced-motion: reduce`; Read keeps the deck's own motion (Josh,
2026-10-17; `packages/app/src/main/motion.ts`, `test/e2e/motion.spec.ts`).

| Deck | What it checks |
|---|---|
| `motion-script.html` | the engine reads the media feature once at load: switching to Review reloads the deck with reduced motion and keeps the URL hash (the slide); Read reloads it with motion |
| `motion-css.html` | the media feature is used in CSS only: the emulation applies live, with no reload |
