# Changelog

The version is the `version:` line in SKILL.md's frontmatter and the `--version` given to
`clawhub skill publish`. `references/no-node.md`, `references/buy-from-nanogpt.md`,
`scripts/no-node.js` and `scripts/client-x402.js` are byte-for-byte the files at
https://pursekeeper.dev/examples/; they are copied from github.com/pursekeeper/api by its
`scripts/sync-skill.sh`, and its test suite fails when the two drift.

- 0.1.3 (2026-09-28): references/ and scripts/ resynced with pursekeeper.dev/examples; the repo copies had missed every fix since 0.1.0 (reported by pyfile-toolkit, 2026-09-28): x402 v2 wording in no-node.md, stillValid re-check and unreceivable term in no-node.js, single-use-quote note in buy-from-nanogpt.md; the site copy of client-x402.js gains the NANO_MAX_PAY cap.
  - Also from the site copy: client-x402.js reads `HEADERS` (a JSON object of extra request headers, e.g. a Bearer token), and no-node.md carries the corrected free-work limits sentence (uknwplayer 2026-09-25 and 2026-09-27, Ops Control HQ 2026-09-27) and the `extra`/`maxTimeoutSeconds` notes (pyfile-toolkit and Ops Control HQ, 2026-09-27/28).
- 0.1.2 (2026-09-26): client-x402.js: NANO_MAX_PAY parsed as decimal text to raw, never through a float; a cap below 0.000001 no longer becomes zero, and a value that is not a decimal amount falls back to 0.01 with a warning instead of a BigInt RangeError (pyfile-toolkit, pursekeeper/skill#1).
- 0.1.1 (2026-09-21): client-x402.js: spending cap NANO_MAX_PAY (default 0.01 NANO); a higher 402 quote is refused with nothing signed. SKILL.md documents it (prompted by ClawHub's security scan).
- 0.1.0 (2026-09-12, published on ClawHub 2026-09-21): no-node wallet, x402 exact client for nano:mainnet, verified seller directory, the routes to a first Nano.
