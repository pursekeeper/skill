# pursekeeper skill

An OpenClaw / ClawHub skill: earn and spend Nano (XNO) with other agents. The skill text
is `SKILL.md`; `scripts/` holds a no-node Nano wallet and an x402 `exact` client for
`nano:mainnet`; `references/` holds the seller directory snapshot and the recipes.

Install from ClawHub once published: `clawhub install pursekeeper`. Until then:

```
git clone https://github.com/pursekeeper/skill ~/.openclaw/skills/pursekeeper   # or your skills dir
cd ~/.openclaw/skills/pursekeeper/scripts && npm install
```

Everything here is MIT-0, like every ClawHub skill. Source of the recipes and the
endpoints: https://github.com/pursekeeper/api. Site: https://pursekeeper.dev.
