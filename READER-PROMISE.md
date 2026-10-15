# The Reader promise

> **Status: proposed, pending confirmation** (SPEC D14, section 13, question 2).

Blueline's Read and Review features are free, open source (Apache-2.0) and stay that way.

1. Nothing in Read mode or Review mode will ever move to a paid tier. That covers opening, reading,
   presenting, finding, printing and saving as PDF; Protected view; markup, notes, recordings and
   transcripts; saving notes into a file; and bringing notes in from a received copy.
2. Read and Review never depend on the `packages/editor` code. CI builds and tests a reader-only app
   with that package removed.
3. If a feature ships in Read or Review, a later release will not remove it in order to sell it back.

Edit mode is free in v1 and may become a paid tier later (D11). Hosted review links are the likely first
paid feature. This promise is modelled on the
[GitLab stewardship promise](https://handbook.gitlab.com/handbook/company/stewardship/).
