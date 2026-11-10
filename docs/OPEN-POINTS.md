# Review notes and open points

10 November 2026. Draft: nothing here is live, and no start block, domain or fee address
is chosen. This page says what a reviewer should read first, what review inside the
project has already found and changed, and what is still open. No outside review has
happened yet.

The rules are [`../RULES.md`](../RULES.md) (draft 3). The code in `rules/lib/` is the
rules: the reader, the check tool, the pages and the wallets all import that one library.
The wallets are not in this repository; points about them are kept here because they bear
on the rules.

## Read first

| # | Question | Where |
|---|---|---|
| 1 | **Claim by one-time key.** A Schnorr signature under the owner coin's one-time key `P`, over a hash that includes the ledger domain and the claim body. Is the form sound, is the nonce handled safely, and does a signature under `P` weaken the later spend of that coin in any way? | `rules/lib/claim.mjs` (`signWithOutputKey`, `verifyOutputKeySignature`), RULES.md section 3 |
| 2 | **Claim by payment proof.** A wallet2 `InProofV2` with an empty message plus a spend-key message signature. Is the proof check complete (subaddress form, one transaction key, output 0 only), and can a view-key holder alone ever claim? | `claim.mjs` (`verifyInProof`, `ownsOutput`), `monero.mjs` (message signature), `ledger.mjs` (claim) |
| 3 | **Payment binding and the fee rule.** A sale counts when each payee received its exact amount as one output the payee's wallet can find and spend. Can a buyer get a Mordinal without the seller and the fee address each holding a spendable coin of the right amount? Can one payment buy twice? | `rules/lib/payment.mjs`, `ledger.mjs` (reserve, buy), `records.mjs` (`amounts`, `heldUntil`), RULES.md section 5 |
| 3a | **Payment proof in buy records. New in draft 3.** A buy record carries, for each payee, the shared secret `D = r·V` and a proof that the same `r` made `D` and a public key the transaction carries, bound to the transaction id, the ledger domain and the listing. It is the wallet2 `OutProofV2` form for one key. Is the proof sound, is the nonce safe in every signer, is everything bound that must be, and can anyone who sees a record (which shows `D`) make a second payment or a second record that counts? | `rules/lib/payment.mjs` (`makeOutProof`, `verifyOutProof`, `checkPaymentProof`, `provePayments`), `ledger.mjs` (buy), RULES.md "Payment proof" |
| 4 | **Record decoding.** Exact decoding, one spelling per record, replay protection by the per-Mordinal counter. | `records.mjs` |
| 5 | **Reader and relay.** Chain order, replaced blocks, restart to the same state, what a relay can and cannot do to a record. | `reader/lib/reader.mjs`, `relay.mjs`, `transport.mjs`, `reader/tools/verify.mjs` |

## Found in review and changed

Rules (all covered by `rules/tests/rules.test.mjs`; the first group also by the wallet
lab with real wallet2 transactions):

- A payee's amount could be put together from several outputs or transactions. Now each
  payee must get its exact amount as **one output**; a payee paid twice in a record is
  refused; a named payment that pays no payee is refused.
- A payment with a **lock time** counted, although the seller could not spend it. Refused.
- A payment counted when the transaction key fit the output but the **public key carried
  in the transaction** was another one, so the payee's wallet would never find the coin.
  Now the carried key must be `r·G` (standard address) or `r·B` (subaddress), read from
  `tx_extra` the way wallet2 reads it, with the right view tag.
- The same **output key** in two payments counted twice; a wallet can spend only one such
  coin. An output key now counts once per payee address. (Counting it once for the whole
  ledger let anyone block a buyer: copy the key of that buyer's payment into an output to
  an address made for the purpose, and record a cheap purchase first.)
- A payment counted when `tx_extra` had **no transaction public key** but the output was
  found through an additional key. A wallet skips such a transaction. Refused.
- A **length written in more bytes than it needs** in `tx_extra` (nonce length, number of
  additional keys) was read; Monero's reader refuses it and stops. Reading now stops there
  too.
- Two reservations could wait for **exactly the same amounts** to the same address, so one
  payment fitted both. A reservation that would repeat a line of any reservation, running
  or run out, on a listing that is still open is refused.
- A reservation ended at its pay-by block, so a buyer who paid in the last blocks could lose
  the listing to someone else before the purchase was recorded. A reservation now holds the
  listing for 10 more blocks (`RULES.settle`).
- A payment in a block after the listing's last block could still buy. Refused.
- An address whose view or spend key no wallet could use (outside the main group, or the
  neutral point) was accepted in records. Refused everywhere.
- **A buy record made the payment's transaction key public.** With that key anyone could
  make a second payment to the same payee with the same output key, record a cheap
  purchase with it first, and so get the first buyer's record refused after that buyer
  had paid. The buy record now carries no transaction key. For each payee it names one
  output and carries the shared secret `D = r·V` with a proof that the key `r` behind `D`
  also made a public key the transaction carries. The proof is bound to the transaction
  id, the ledger domain and the listing, so it does not fit a copied payment or another
  listing. A record is 296 bytes (two payees) or 425 bytes (three). The rule library, the
  reader, the market page and the wallets all use the new record; an older reader state folder is refused. The proofs in
  a record are accepted by wallet2's own `check_tx_proof`, and proofs wallet2 makes are
  accepted by this check (wallet lab).

Review of the payment proof and the new buy record (10 November, two independent
reads; neither found a way to get a Mordinal without paying, to make a second record
that counts from a published one, or to learn a transaction key from a record):

- The proof check did not look at the **payee's own keys**. A view key outside the main
  group, or a subaddress with a spend key no wallet can use, is now refused in the proof
  check itself, and a ledger whose fee address has such a key is refused as a whole.
- A payment counted when the transaction's **first public key was not a usable point**
  and the output was found through an additional key. Refused now, also through an
  additional key.
- The proof's **nonce** came from random bytes alone. It is now a hash of fresh random
  bytes, the key and everything the proof covers, so a weak random source cannot make
  two proofs share a nonce.
- **Replaced blocks could put a purchase record before its own payment.** The record was
  then refused for good, while the buyer's wallet had already deleted the payment's keys
  and could not make it again. The relay now sends such a purchase again (at most twice),
  or holds it until the payment is in a block. The wallets keep the record and the
  payment's keys until the purchase is 10 blocks deep.
- Saved payment keys were removed only when the buyer opened the reservation again. They
  are now tidied every time the Mordinals screen opens, and kept for 60 days at most.
- **"Start the payment again" deleted the first payment's keys.** If that payment reached
  the network later, the buyer could not prove it. It is now put aside; when the node
  knows it after all, the wallet finishes the purchase with it and does not offer to pay
  a second time.
- **A payment read from blocks that were replaced.** The reader took the node's word for
  the block a payment is in. If the node answered from blocks that were replaced a moment
  later while the record's own block stayed, the saved answer was never asked again. The
  reader now asks for the block at that height: it has to have the hash in the reader's
  own journal and has to list the payment. Otherwise the block is read again.
- RULES.md now says what a purchase makes public for good: the payment's transaction id
  and paying outputs tied to the buyer's address, the shared secret of each of those
  outputs, and by elimination the buyer's change coin.
- The proof number called `r` in entries is now called `s`; the bytes of a record did not
  change.

Wallets (test builds, not in this repository):

- A wallet rebuilds the listing and the reservation from their own signed records, checks
  their codes, and shows amounts to pay only for a reservation it made itself. It does not
  take amounts from the service's answer.
- Before paying it compares the service's block height with its own Monero node's and
  refuses when either is within 3 blocks of the pay-by block.
- After a payment that may or may not have gone out, it never offers to pay again; it
  offers to start again only once the payment is known not to exist, and keeps the first
  payment's keys in case it turns up.

Service:

- Stored payment facts now include the lock time and `tx_extra` (state format
  `mordinals-reader-v3` since buy records carry proofs; an older state folder is refused,
  not converted). `GET /tx/<txid>` gives a wallet the public facts of a payment it is
  about to prove.
- Posting needs `content-type: application/json`, so another website cannot post from a
  visitor's browser without the service agreeing first.
- The request limit can follow the caller named by the machine's own proxy
  (`--behind-proxy`); without that option the forwarded header is ignored.
- Many visitors asking for waiting records share one look at the node's pool.
  `GET /records` is paged. Extensions can be limited to listed ids (`--allow-extension`).

## Still open

Rules:

1. **Free reservations.** A reservation costs nothing, so a listing can be held by
   repeated reservations (30 + 10 blocks each). Someone who knows a buyer's address can
   also reserve first to take the amounts that buyer would get. A small reservation
   deposit or a relay limit per buyer would answer both; not designed.
2. **Same amounts again.** When the pay-by block is limited by the listing's last block, a
   refused reservation tried again gets the same code and the same amounts; it has to wait
   until the other reservation is over.
3. **Late payments.** A payment after the pay-by block counts only while nobody else has
   reserved and the listing is open. The wallets refuse to pay late; a payment made by hand
   is at the payer's risk.
4. **Output keys outside the ledger.** An output key is counted once per payee inside the
   ledger. A payer who made an earlier transaction to the same address outside the ledger
   can repeat that transaction's key, so the new payment has the same output key. The
   payee's wallet then keeps one of the two coins: the larger one, or none of the new one
   if the old coin was already spent. The payer still pays the full price and gains
   nothing; the seller can lose the sale's money.
   A check "this output key was not on the chain before" was tried and taken out again,
   because it is worse than what it closes: the key of a waiting payment
   is public, anyone can copy it into an output of a transaction of their own and get that
   mined first, and the honest payment would then be refused after the seller was paid.
   An exact rule would have to refuse only an earlier output that the payee's wallet takes
   for the same coin (same output number, same transaction public key, amount that opens
   with the record's shared secret and is not smaller). Nobody can make such an output
   before the buy record is public; afterwards it takes replaced blocks. It cannot see
   whether the old coin was spent, and it needs the reader to keep every output key of the
   chain (a Monero node cannot look a key up; about 1 GB a year, several GB from the first
   block). Not built.
5. **Stronger binding.** The proof in a buy record is bound to the listing, not to one
   reservation; the exact-amount tail still tells reservations on one listing apart. The
   output number and, for a standard address, the spend key are not in the proof's hash;
   the output check fixes both.
6. **Hand-made payments on a real node.** Locked payments and payments with odd `tx_extra`
   were tested as made-up transactions. The lab wallet refuses to make a locked payment, so
   none was mined on the test chain.
7. **Domain.** Test value only. The final domain should be derived from the network, the
   fee address, the start block and the owner-list hash.

Reader, relay, service:

8. **Relay fee.** The relay's wallet pays the Monero fee of every record and charges
   nothing. Whether it charges is not decided; wallet wording follows that decision.
9. **Carrier coins.** A coin is marked used when its transaction is built; if the
   transaction is never published the coin stays unused until the state is rebuilt.
10. **Checkpoints** are statements of whoever runs the reader: not signed, not anchored on
    chain. `verify` shows that nothing was left out only with `--scan`.
11. **Wallets trust the service for the current state** (who owns what, what is listed,
    the block height). They check the owner list, every record they act on and every
    amount they pay, but they do not replay the log or compare with public checkpoints.
12. **Sensitive-picture mark** (`x-mordinal-sensitive`) is the service's own statement.
13. Reading requests are not rate-limited by the service; a front proxy has to do that.

Wallets:

14. **A real payment from a wallet build has not been made.** Wallet tests use a stand-in
    for the Monero side. Extra transaction keys for a subaddress seller have not been
    checked against a transaction made by that wallet build.
15. **Transaction keys in storage.** From paying until the purchase is 10 blocks deep, the
    payment's transaction key is kept in the wallet's storage so the proofs can be made
    again after a reload or after replaced blocks. It is deleted afterwards and is never
    part of a record.
16. **Feather and Cake holders** have no tool for the payment-proof claim yet; it exists as
    library functions run in the wallet lab only.
17. **Video content.** The added entry (number 42,894) is a video. The service serves
    pictures only, so the pages show it without its content.

## Tests

| Test | Result on 10 November 2026 |
|---|---|
| Rule library, offline (`rules/tests/rules.test.mjs`) | 23 of 23 |
| Wallet lab: real wallet2 wallets on a local test chain (`rules/tests/lab.test.mjs`) | passed: 22 records accepted, 27 refused as expected; Feather and Cake claim lab passed (6 accepted, 1 refused) |
| Reader, relay, service, check tools, offline (`reader/tests/reader.test.mjs`) | 10 of 10 |
| Reader lab: local Monero test chain, real carrier transactions (`reader/tests/lab.test.mjs`) | passed |
| Pages in a browser (`reader/tests/views.test.mjs`) | 15 of 15 |

The saved lab cases hold no transaction key.

Not run: anything on mainnet or stagenet; the Feather and Cake apps themselves.
