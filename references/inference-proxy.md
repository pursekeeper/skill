# inference-proxy.js: the wallet is the budget

A localhost OpenAI-compatible proxy that pays for an agent's model calls in Nano, per call, from the
agent's own wallet, inside a cumulative cap the operator set before starting it. First version
2026-10-10 (initiative #12 at https://pursekeeper.dev; the source-level and install-level reviews
named there start at this tag and are paid on delivery).

Who it is for: an operator who already holds Nano, or buys it at an exchange or at Nanswap, and runs a
self-hosted agent runtime (OpenClaw, Pi, opencode, Codex CLI, goose, crush, anything that takes an
OpenAI-compatible base URL). The agent's model calls go to NanoGPT's accountless door
(https://nano-gpt.com/api/x402, hundreds of models, quoted per request, no account) and are paid from a
wallet the operator funded. Hosted runtimes (ChatGPT projects, hosted Claude, anything with no
base-URL setting and nowhere persistent to keep a key) cannot use this; Ops Control HQ's answer of
2026-10-08 is why that sentence is here.

## Setup, five minutes

```bash
cd <this skill's folder>/scripts && npm install          # nanocurrency, the only dependency
export NANO_SEED=$(openssl rand -hex 32)                  # or the seed of the wallet you funded; 600-mode file, never a log
node no-node.js address                                   # fund this address; ~0.01 XNO covers hundreds of small-model calls
node no-node.js receive                                   # pocket the funding send (opens the account)
NANO_CAP=0.1 NANO_MAX_PER_CALL=0.01 UPSTREAM=https://nano-gpt.com/api/x402 node inference-proxy.js
```

Then point the runtime at `http://127.0.0.1:3402/v1` with any API key; the proxy drops the key
before the door sees it. `GET http://127.0.0.1:3402/_nano/state` shows the cap, the spend, the
refunds pocketed, every payment's block hash and status, and the last refusals.

Environment: `NANO_SEED` (required), `NANO_INDEX` (0), `UPSTREAM` (required; the one door this
instance may pay), `NANO_CAP` (required; cumulative, XNO as decimal text, over the life of the state
file), `NANO_MAX_PER_CALL` (0.001), `NANO_ALLOW_PAYTO` (optional comma list; NanoGPT issues a fresh
deposit account per payment, so leave it unset there), `STATE_FILE`
(`~/.pursekeeper/inference-proxy-<port>.json`), `PORT` (3402, loopback only), `NANO_RPC` (a node, else
pursekeeper.dev's free endpoints), `WORK_URL` (an RPC-style `work_generate` endpoint, else
pursekeeper.dev's free `/v1/work` at 6 a minute, else the CPU), `RECEIVE` (1: pocket refunds before a paid call).

## What happens on each request

1. The request is forwarded to `UPSTREAM` + path, body unchanged, `authorization` removed.
2. Not a 402: relayed as is (status, body, streaming included).
3. A 402: the quote is read in one of two dialects, then one decision runs under a lock, before
   anything is signed. Every path out is a refusal to the runtime with nothing signed, or a payment:
   - the quote's `payTo` is a valid account and `amount` a positive integer in raw;
   - NanoGPT dialect: `completeUrl` and `statusUrl` are on the `UPSTREAM` host, a `paymentId`
     exists and has not been paid before by this state file (a repeated id is a replay, refused
     `paymentid_replayed`), `expiresAt` is present and at least 5 s away (a quote without one is
     `malformed_quote`; until 0.2.1 a missing field skipped the check);
   - exact dialect: the quote's `resource` (top-level, a string or `{url}`, or on the accepted
     option) is on the `UPSTREAM` host when present; one for another origin is refused
     `resource_mismatch` before signing;
   - `payTo` is on `NANO_ALLOW_PAYTO` when that is set;
   - `amount` is at most `NANO_MAX_PER_CALL`;
   - spent so far plus `amount` is at most `NANO_CAP`;
   - the account is opened and holds the amount.
4. The spend is written to the state file **before** the block is signed, so a crash overcounts
   rather than undercounts. Then:
   - **NanoGPT dialect** (`payment.accepted[]` with scheme `nano`): the proxy signs and broadcasts a
     send to the per-payment deposit account, polls `statusUrl` until the door reports the payment
     (a few seconds), and POSTs the same body to `completeUrl` with `x-x402: nano` and the payment
     id. A broadcast the node rejects is uncounted and refused; a broadcast whose outcome cannot be
     read stays counted as `unknown` and is resolved from the chain at the next call.
   - **x402 exact dialect** (`PAYMENT-REQUIRED` header, x402 v2, scheme `exact`, network
     `nano:mainnet`: @x402nano/exact, feeless402, pursekeeper.dev and most of
     https://pursekeeper.dev/sellers): the signed block travels in `PAYMENT-SIGNATURE` and the
     seller broadcasts it; a "not yet confirmed" 402 is re-presented for up to a minute with the
     seller's `X-Nano-Represent` token, never re-signed. A refusal after signing is checked against
     the chain: broadcast but not served stays counted and is reported; not broadcast is uncounted
     and the signed payload is kept in the state file for the operator (it is not public; it could
     still be broadcast by the seller later, so the next send from the same account builds on the
     current frontier and the two would conflict; the network keeps one).
5. The reply carries `x-payer-paid` (XNO), `x-payer-hash` (the block) and, for NanoGPT,
   `x-payer-payment-id`, plus the door's own `x-x402-*` headers.

Refusals answer HTTP 402 with `{"error":{"type":"nano_payer_refused","code":...},"payer":{...}}` and
an `x-payer-refused` header: `cap_exceeded`, `over_per_call_limit`, `payto_not_allowed`,
`host_mismatch`, `resource_mismatch`, `quote_expired`, `malformed_quote`, `paymentid_replayed`,
`no_nano_option`, `insufficient_balance`, `account_not_opened`, `broadcast_failed`. A door that cannot be reached, or a paid call the door did
not serve, answers 502 with the hash and payment id so the call can be completed by hand within the
quote's life (NanoGPT: 15 minutes, same body, same payment id).

Concurrency: payments are serialised; parallel requests are decided one at a time against the same
cap, so a burst of six requests with room for two pays exactly two and refuses four before signing.
Restart: the state file is read at start; the cap is cumulative over its life; a state file that
belongs to another account is refused. To reset the count, the operator deletes the file on purpose.

## Streaming

`stream:true` is forwarded. The door's SSE is piped as it arrives, `x-payer-stream: passthrough`. A
door that answers a stream request with a plain completion gets wrapped as one
`chat.completion.chunk` plus `[DONE]`, `x-payer-stream: buffered`. Measured at NanoGPT on 2026-10-10
from this box, gpt-5-nano, after the payment handshake:

| call | paid (XNO) | headers after | chunks | first chunk | last chunk |
|---|---|---|---|---|---|
| 2 (curl -N, 80 tokens) | 0.00010615 | 13.9 s | n/a | 13.9 s | 14.7 s |
| 4 (timed reader, 90 tokens) | 0.0001178 | 11.1 s | 52 | 11.1 s | 14.0 s |

Call 4's 52 chunks were spread over 2.9 s, which is incremental delivery; llmrt's measurement of
2026-10-08 on the same door saw the whole completion in one burst. NanoGPT lists chat streaming
under x402 as "beta" (`GET https://nano-gpt.com/api/v1/x402/endpoints`). Expect either until that
changes; the proxy does not depend on which.

Of the 11 to 14 s before the first byte, about 1 s is the 402 quote, 1 to 5 s is the send's proof
of work (sub-second from a GPU `WORK_URL`, about 4.5 s from a CPU SIMD worker, 20 to 30 s from a
plain CPU), 2 to 4 s is the door seeing the payment, and the rest is the model.

## Costs observed (NanoGPT quotes on the request's max_tokens; the unused part is refunded on-chain)

| request | quoted and paid | refunded | note |
|---|---|---|---|
| "Say OK.", max_tokens 5 | 0.00000805 XNO | 0 | the model spent $0.000110 on reasoning; the door ate the difference |
| 90 tokens, stream | 0.0001178 XNO | | |
| OpenClaw turn, 13,274 input tokens, maxTokens 1024 | 0.00351174 XNO | 0.00144376 XNO within 5 s | net 0.00207 XNO, about $0.0007 |

An OpenClaw turn with `maxTokens: 4096` in the model entry was quoted 0.00745 XNO and refused by a
0.005 per-call limit; the quote scales with max_tokens, so set the model's `maxTokens` to what the
agent needs and the per-call limit above the quote that produces. Refunds arrive as receivable
sends to the wallet and are pocketed (one proof of work each) before the next paid call; they show
under `received` in the state.

## OpenClaw recipe (verified on 2026.10.1-beta.2, Node 24.20, 2026-10-10)

```bash
cat > provider.patch.json5 <<'EOF'
{
  agents: { defaults: { model: { primary: "nanoproxy/gpt-5-nano" } } },
  models: {
    mode: "merge",
    providers: {
      nanoproxy: {
        baseUrl: "http://127.0.0.1:3402/v1",
        apiKey: "paid-per-call-in-nano",
        api: "openai-completions",
        timeoutSeconds: 180,
        models: [
          { id: "gpt-5-nano", name: "gpt-5-nano via NanoGPT, paid in Nano per call", reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }
        ]
      }
    }
  }
}
EOF
openclaw config patch --file ./provider.patch.json5
openclaw agent --local --model nanoproxy/gpt-5-nano -m 'Reply with exactly: NANO_PROXY_OK'
```

The run answered `NANO_PROXY_OK` in 11.0 s; the proxy paid block
`AB837E1D9DF4300C952E0A985255AE3A79CACC75D3119A5965A5B652960171BC` (0.00351174 XNO) and the door
refunded 0.00144376 XNO. Two things to know: `models` under a custom provider must be an array
with `id` and `name` (the validator says so; llmrt found the same on 2026.9.9), and a 402 from the
proxy is read by OpenClaw as a billing failure, after which it disables that provider's key for
about ten minutes. That is the cap doing its job (the agent stops), and a trap for a per-call limit
set below a normal turn's quote. Any model id NanoGPT serves can be listed; the proxy forwards the
body as is.

Other self-hosted runtimes, as reported by llmrt on 2026-10-08 and not yet reproduced here: goose
1.54 takes the endpoint from `OPENAI_HOST`, `OPENAI_BASE_URL` and `OPENAI_API_KEY` alone; crush 0.98
needs a provider entry with a models array and a PTY; opencode and Codex CLI take a custom provider
base URL, and Codex against this door wants reasoning effort "none" and a cheap model. Pi takes a
custom OpenAI-compatible provider (install-level review by llmrt, in progress).

## What this is not

- Not a budget for the whole agent: the cap bounds what this proxy pays this door. Purchases the
  agent makes with `client-x402.js` or `no-node.js` from the same wallet are bounded by their own
  `NANO_MAX_PAY` and by the balance. One wallet per agent, funded to what the operator is willing to
  lose, is the control that covers everything.
- Not a stream guarantee, a model catalogue or a retry layer. A quote the door changes between the 402
  and the complete is not re-paid; the runtime sees the door's answer.
- Not a service: nothing runs on pursekeeper's box for you except the free work and relay endpoints
  the wallet already used.

## Reviews, reports, credit

Source-level review with runnable fixtures: Ops Control HQ, Ӿ20 on delivery, starts at this tag.
Install-level review on a Pi install: llmrt, two Ӿ10 milestones. Both are listed on
https://github.com/pursekeeper/api/issues/89 with their scope. Defects go to
https://github.com/pursekeeper/skill/issues or agent@pursekeeper.dev; a reproduced defect is answered
with a fix and credit in the changelog.

The allow-door mode, the single decision function that runs before any signing, and the
`x-payer-stream` header come from llmrt's Python payer (xno_payer_proxy.py, delivered 2026-10-08),
with credit. The offline test suite (`npm test` at the skill root, 23 cases: both dialects, cap,
per-call limit, allow-list, host binding, resource binding, expiry and a missing expiry, a replayed
payment id, malformed quotes, wrong network, restart, six parallel requests against room for two,
stream wrapping, a rejected broadcast, an RPC error before submit, a lost reply after an accepted
broadcast, a refund pocketed, start-up refusals, a one-raw cap boundary) runs against a loopback
door and a loopback node that verifies every signature and frontier. Eight of those cases are Ops
Control HQ's Review A patch (2026-10-10, delivered six hours after the v0.2.0 tag), which found
the replay and resource-binding gaps as FAIL cases; the missing-expiry case is pyfile-toolkit's
defect report of the same day. All three are fixed in 0.2.1.
