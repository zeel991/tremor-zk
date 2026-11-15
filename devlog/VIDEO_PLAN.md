# Creator Track video: building ReceiptProof

## Rules this must meet
From agentgames.zkverify.io/events/creator-track (read 2026-11-14):
- **Judged on:** technical substance, clarity for newcomers, zkVerify relevance, originality.
- **Post:** a public VIDEO on YouTube or X with `#AgentGames`; on X also tag `@ZKVProtocol`.
- **Deadline:** 21 Nov 2026. Post after the first on-chain claim, so the video can show real links.

## Concept
**"An AI can fake a receipt in 10 seconds. It can't fake this."**

Through-line: *a receipt that proves itself, without showing anyone your email.*

Two cuts: 4–6 min main, 60–90 s vertical for X.

## Beats (captured while building; `capture.sh` logs each to LOG.md)
| # | Beat | ~sec | On screen | Status |
|---|---|---|---|---|
| 1 | Hook: an AI-generated receipt passes a glance | 15 | Generate a fake receipt image, then "would your finance team catch this?" | to capture |
| 2 | "But it has no signature": DKIM in a real email | 30 | "Show original" on a real receipt (blur PII), with the `DKIM-Signature` header highlighted | needs your receipt |
| 3 | ZK in one picture: prove it's signed, reveal only the total | 30 | Diagram: email → circuit → 9 public values; everything else stays home | draw |
| 4 | The circuit catches a tampered amount | 30 | Terminal: `npm test`, the ATTACK lines going green; edit 1,249.50 → 9,249.50 and the proof fails | can capture now |
| 5 | A proof in the browser in seconds | 30 | Web app step 3 with the timings; network tab showing only proof + 9 numbers leave | can capture now (local) |
| 6 | Why V5_0: we use the sound ZK flavour | 25 | zkVerify source line marking the old ZK flavours unsound, plus `state_getRuntimeVersion` mainnet vs Volta | can capture now |
| 7 | First verification on zkVerify | 30 | Kurier job → zkVerify explorer | after G1c |
| 8 | First USDC payout on Base | 30 | Vault `Claimed` event, Basescan | after deploy (your yes) |
| 9 | Verify a payout yourself | 30 | Paste the tx: every check turns green | after 8 |
| 10 | What it doesn't prove | 20 | Limits list | any time |
| 11 | Try it + repo + `#AgentGames @ZKVProtocol` | 15 | Sandbox URL / QR | at the end |

## Who does what
- **I capture:**
  - terminal runs, browser steps and explorer pages
  - `LOG.md` with what happened and why
  - from that: a voiceover script, the title, the post text, and a rough cut with ffmpeg
- **You:**
  - record the voiceover or face-cam intro
  - supply a real receipt for beat 2, blurred
  - approve the cut
  - post it. I never post.
- **External editors** (e.g. invideo) upload footage to a third party, so I ask first.

## Capture rules
- No secrets on screen: no `.dev.vars`, Kurier key, agent/relayer keys or the sample DKIM key.
- Real receipts stay in `fixtures/private/` (gitignored). Blur names, addresses and order ids.
