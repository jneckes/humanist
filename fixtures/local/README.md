# Local fixtures (gitignored)

Josh's real decks live here and are never committed (SPEC section 13, question 1).
Their coverage baselines go in `fixtures/local/expected/`, never in `fixtures/expected/`, because a
baseline contains each run's text (SPEC section 11).

    npm run build
    node packages/cli/dist/blueline.cjs map fixtures/local/<deck>.html --report --json
