# Build log (voiceover source)
- 2026-11-15 · beat 6 · zkVerify's verifier source marks ZK proofs from bb 0.84/3.0 as unsound; mainnet still runtime 2.0.0, Volta 2.1.0 → build on V5_0, Volta + Base Sepolia.
- 2026-11-15 · beat 4 · Ported zk-email to Noir 1.0 (zkPassport RSA/bignum forks, Barrett redc needs +6 bits). Full receipt circuit: DKIM + body hash + anchor + amount + date + to_commit + salted nullifier.
- 2026-11-15 · beat 4 · Found and closed a nullifier bug class: without `signature < modulus`, s+n also verifies and would mint a second nullifier for the same email. Attack test added.
- 2026-11-15 · beat 4 · Dropped soft-line-break decoding: match the anchor on raw signed bytes instead (sound, smaller circuit).
- 2026-11-15 · beat 5 · Full circuit proves in 1.8 s (10 threads, node) / 10.8 s single-thread in a browser; vkHash confirmed by Volta's own vk_hash RPC.
- 2026-11-15 · beat 9 · Contract fork test: zkVerify's real Base Sepolia aggregation contract accepts a real path (aggregation 65470) and rejects a flipped leaf.
- 2026-11-15 · beat 5 · Privacy check on the actual request: the agent received only vaultId, circuit, proof, pubs, note.
