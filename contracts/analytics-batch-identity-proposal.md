# Proposed batch identity lifetime — pending owner approval

This is an explicit normative proposal, not an approved replacement for analytics-ingestion-v2. The existing global arbitrary UUID protocol and its fail-closed pruning guard remain unchanged. No endpoint, runtime flag, migration or operational activation is introduced by this contract.

## Problem and chosen candidate

A bounded store cannot forget arbitrary historical UUID bindings, reject their reuse forever and accept all new arbitrary UUIDs indefinitely. An infinite UUID tombstone set is not proposed. A shorter tombstone TTL alone is unsafe.

Propose an alternative **Control Plane issued batch identity**. Keep the existing monotonic PostgreSQL admission position as the durable replay frontier. No per-batch perpetual registry is needed. The existing producer bearer, stream, node, pod and authorized cluster history must still be validated; the identity token never replaces authentication.

## Identity envelope

The CP signs a canonical, versioned envelope containing instanceId, streamId, authorizationId, next admission position, descriptorDigest, issuedAt and expiresAt. The position is a positive signed-Int64 decimal, expiresAt is exactly issuedAt + 15 minutes, and the CP clock is authoritative. The descriptor digest is SHA-256 of the existing ordered descriptor tuples [copyId,id,commitment,expiresAt]. Digests bind integrity; they do not assign Workspace ownership or replace exact copy conflict comparison.

Use the existing server fingerprint/HMAC primitive, with distinct domains for the token and UUID. The batch UUID is a version-8 UUID derived from the signed envelope's domain-separated HMAC, not chosen by the producer. A full 256-bit HMAC authenticates the token; the UUID is a compact handle, never the authentication proof. Collision resistance is cryptographic, not a mathematical guarantee that UUIDs can never collide. A detected live UUID collision is rejected rather than overwritten.

The token has at most 2048 characters. It contains technical identities and a digest, no payload, path, IP, bearer, signing key or credentials. Never log the token or HMAC key. Key distribution/rotation uses the existing encryption/fingerprint mechanism; a removed key causes safe rejection, not automatic reissuance of the old identity.

The cipher keyring and the fingerprint key are distinct. AES write/read-key rotation with the same fingerprint key preserves tickets. Replacing the fingerprint key immediately invalidates existing tickets, including those younger than15minutes; there is no HMAC keyring or grace period in this proposal. Fifteen minutes is a maximum validity, not a promise to override revocation or key replacement. This operational implication requires owner acceptance before adoption.

## Admission and retries

1. Minting validates the current producer and stream under the existing admission lock, reads counter+1 and signs that position. It does not reserve the position or prove persistence. Audit records only streamId, position, batchId and counts, not the token.
2. Admission revalidates producer/stream/authorization, verifies HMAC, derived UUID, exact descriptor digest and authoritative lifetime in the same transaction that updates the counter and inserts the batch/audit.
3. If the exact batch still exists and the token is valid, identical replay returns its existing generation. Conflicting content/stream/authorization is rejected.
4. If the binding has been pruned, a token for an already consumed position is rejected. An expired token is rejected even if its payload remains; this explicitly bounds retry lifetime. Missing history never creates a positive receipt.
5. A fresh verified envelope may pass the legacy history-pruned guard only when its position equals counter+1. A stale concurrent mint loses with 409 and must obtain a fresh identity for a new attempt; there is no internal infinite retry loop.
6. The counter never decreases, including after GC/restart. Rollback does not consume a position. Signed-Int64 exhaustion rejects admission. A new instance identity must not claim continuity with a lost counter.
7. Old producer authorization, another stream/instance, altered body and arbitrary UUID are rejected. The token proves identity binding only; no persistence, fence, copy completeness or delivery-from-Kong flag is enabled by it.

The proposed namespace reserves version-8 batch UUIDs for authenticated envelopes. A consumer without the policy refuses version-8 handles rather than admitting or retrying them through the arbitrary-UUID path. This is an explicit compatibility decision requiring approval; any pre-existing arbitrary version-8 handles need a separately reviewed refusal/migration policy before adoption. Other old-protocol UUIDs remain supported under their existing conservative rules. This alternative is isolated until approved. No silent reinterpretation of UUID lifetime, retry semantics or error codes is permitted. Mapping new error details to an eventual public ingestion API requires its own approved wire contract.

Before migration, inventory producer capabilities and any live arbitrary version-8 bindings. Do not reinterpret an old UUID as a signed identity or renew an expired envelope implicitly. Producers selecting the proposed profile must obtain a CP-issued identity for a new allowed attempt; retrying the original identity after expiry or pruning never reserves another position. Legacy producers remain on the original protocol, including its fail-closed behavior after global UUID history is lost. Mixed deployment is not transparent compatibility with arbitrary legacy version-8 handles.

Restore must preserve the monotonic counter and its surviving evidence. A counter below prune coverage or any surviving admission is inconsistent and must be refused. A coherent rollback of the entire database to an earlier state cannot be detected by that database alone. Such recovery requires external continuity evidence or a new authorization/identity that cannot claim the old frontier; absent that procedure, keep the proposed producer path unavailable. Recreating a service object is not evidence of physical restart or backup recovery.

## Retention and evidence

Raw/admission payload and negative conflict evidence retain the existing 1–7 day policies. Tokens expire after 15 minutes and need not be retained by the server; one monotonic counter survives batch pruning. The stream/authorization history follows its existing lifecycle and is not deleted or extended by this proposal. It does not solve bounded stream-history retention or sustained serving after pruned physical prefixes; those remain separate constraints.

Approval required: derived UUID namespace, 15-minute retry lifetime, stale-mint conflict behavior and the new proof-bearing internal admission method. Experimental implementation/tests may depend on this proposal only in isolated branches explicitly authorized by R22. No merge or operational activation is approved.

R25 also authorizes isolated consumers and tests of this direction. It does not grant normative approval, merge, automatic migration, or installation in an operational factory. Batch identity is not a lifetime contract for the normative Request ID; pruning request comparison history must still fail closed when a later copy cannot be safely compared.

## Adoption checklist for approval (R26)

| Producer/recovery state | Proposed behavior | Compatibility boundary |
| --- | --- | --- |
| Legacy non-v8 batch | Keep original protocol, including post-prune refusal | No automatic conversion or retry-lifetime extension |
| Existing arbitrary v8 handle | Refuse under the proposed namespace; inventory and explicitly retire/migrate its producer | Never reinterpret it as a signed envelope |
| Proposed producer, valid ticket | Reauthenticate stream/node/history; return exact live retry or admit next position transactionally | Ticket possession alone is not authorization |
| Expired ticket, stale competing mint, or consumed position without the exact live binding (including pruning) | Reject409; a newly allowed attempt requires a fresh CP identity; a valid exact live retry keeps its existing generation | No renewal, recycled UUID or counter regression |
| Partial restore inconsistent with surviving coverage/live admissions | Refuse mint and exact retry409 | The existing frontier checks are implemented and tested |
| Coherent full restore with no external continuity evidence | Do not resume the proposed producer path as continuous | No automatic local rollback detector is implemented; recovery needs a reviewed external checkpoint or new instance/authorization identity without claiming the old frontier |

The owner decision approves these internal identity/retry semantics and their explicit migration costs, not a public ingestion HTTP protocol or an operational recovery service. Before activation, the operator must qualify the restore procedure and producer cutover; the prototype does not silently detect or authorize a coherent full restore. No consumer default, environment switch or factory activation is changed by this proposal.
