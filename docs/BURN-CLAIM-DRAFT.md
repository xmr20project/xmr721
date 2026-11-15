# Claiming by burning: draft (15 November 2026)

Status: a local candidate. No ledger uses it, nothing here is switched on, and it has not
been reviewed. The rule is [`../RULES.md`](../RULES.md) section 10; this page says what was
built, how to try it, what is decided and what is not, and what a reviewer should attack
first.

## The change in one paragraph

Today a Mordinal is claimed by a record that proves control of its owner coin and spends
nothing (RULES.md section 3). With this change a ledger can name a **first burn block**.
From that block on claim records no longer count, and a Mordinal is claimed by **burning
it**: a transfer in the original 2023 Mordinals format whose ring is the owner coin and the
fifteen dead outputs, whose output 0 pays an address nobody can spend from, and whose text is
`xmr721 claim to <address>`. Under the original rules the old Mordinal then sits on an
unspendable output; here it belongs to `<address>`.

## What was built

| Where | What |
|---|---|
| `rules/lib/burn.mjs` | Monero's `hash_to_ec`, the burn address and its public view key, the dead outputs, the strict reading of `tx_extra`, the text, the ring, the fee, the check that output 0 pays the burn address |
| `rules/lib/ledger.mjs` | `burnFrom` and `burnDead` in the setup; `checkBurnClaim` / `applyBurnClaim`; claim records refused from the first burn block on |
| `reader/lib/reader.mjs` | finds original-format transfers from the first burn block on, journals each (accepted, or refused with the reason), rebuilds from the journal, undoes them when blocks are replaced; the setting is part of the folder's identity and of checkpoints from that block on |
| `reader/lib/owners.mjs` | a second hash, over each entry's owner output index, which the owner-list hash does not cover |
| `reader/service.mjs` | `--burn-from`, `--burn-dead`; `/info` (`burnFrom`, `burn`), `/entry/<txid>`, `/mordinal/<n>` (`ownerOutput`), `/records` |
| `reader/tools/verify.mjs` | replays logged burn claims, compares them with the node, checks the setting in checkpoints |
| `reader/views/` | the XMR721, Mordinal and About pages explain the burn when `/info` reports it; unchanged otherwise |

A reader without `--burn-from` does what it did: same journal, same folder, same checkpoints,
same answers. This was compared byte for byte against the code before the change on one
made-up chain holding records, mints, burning transfers and a replaced block.

## Trying it

```
npm test                    # includes rules/tests/burn.test.mjs and reader/tests/burn.test.mjs
npm run test:views          # includes reader/tests/burn-views.test.mjs
MONERO_BIN=… MORDINAL_OLD=… node --test reader/tests/lab-burn.test.mjs
```

`rules/tests/fixtures-burn.json` holds one real pair of mainnet transactions: a registration
in the original format (block 3,806,656) and the transfer of its owner output to the burn
address (block 3,806,759). The rule accepts the pair; that inscription is not on the
ledger's owner list, so the test puts it on a list of its own.

The lab test runs a real registration and a real burning transfer on a private chain, built
by a separate tool that is not in this repository (`MORDINAL_OLD` names its binary), and
has the reader accept the transfer from a real node. Without the tool it is skipped.

To switch a reader on: `--burn-from <height>`. A state folder that has not yet read that
block takes the setting in when it is restarted with it; one that has read it is refused
and has to be read again from the start block.

## Decided in this draft (each can be argued with)

1. **`tx_extra` is read more strictly than the original parser reads it**: only a public
   key, a nonce, additional keys and exactly one `0x11` field. Whatever passes, the original
   parser reads the same way. The price: a transfer with padding or another field moves the
   Mordinal under the original rules and claims nothing here, and its coin is spent. The
   original wallet's transfers do not look like that: 100 of the 165 transfers of 2023 were
   read with this parser, all pass, all have the layout `01 02 11`.
2. **The first ring the original rule would take decides.** A transaction with two such
   rings claims only by the first, as the original moves only by the first.
3. **70499745 is not dead.** A ring with it claims nothing here and still moves the Mordinal
   for the original rules.
4. **Additional public keys are not used** to find the payment to the burn address. A wallet
   pays a main address with the transaction key itself.
5. **The view tag of output 0 must be right** when it has one, so a view-only wallet of the
   burn address sees every burn. The amount is not looked at (the tool pays 1 piconero).
6. **The text is exact**: no line end, no integrated address, the ledger's network only.
7. **The dead outputs and the owner output indexes are part of the ledger's identity**: the
   state folder and, from the first burn block on, every checkpoint name them.
8. **Every original-format transfer from the first burn block on is journaled**, also one
   that has nothing to do with XMR721, so `/entry/<txid>` can say why a burn did not count.
9. **The id of a burn claim** (what `/status/<id>` and events carry) is
   `SHA-256("XMR721-BURN-CLAIM-v1" 0x00 ‖ domain ‖ txid)`.

## Not decided

1. **Holders whose owner coin is already spent.** An owner coin that an ordinary wallet
   spent as money (many 2023 wallets could do that without noticing) cannot be spent again,
   so its Mordinal cannot be claimed by burning. Today such a holder can still claim with
   proof 0 or proof 1, which need the keys and not the coin. From the first burn block on
   this draft leaves them **no way**. How many of the 42,894 owner coins are spent is not
   known and cannot be read from the chain (their rings are ordinary). A fallback would
   bring back exactly the claim this change removes, for anyone who says the coin is spent;
   whether a spent coin can be shown (a key image with a proof of spend) was not designed.
2. **The one Mordinal claimed before the rule, #42,875.** It stays claimed by its record.
   Its old Mordinal is not burned: under the original rules it still sits on its owner coin
   and can be moved there. Nothing here asks its owner to burn it afterwards, and a later
   burning transfer of it is refused as "already claimed" (and would still move it for the
   original rules). The same holds for any claim accepted before the first burn block.
3. **Who could hold dead output 70499745, and the other fifteen.** 70499745 has an ordinary
   key; whoever made it may be able to spend it. That is why it is left out. For the fifteen
   `deadbeef…` outputs nobody has shown that no secret key exists: the claim "dead" rests on
   the keys being bytes nobody chose a secret for. Whether each of those fifteen byte strings
   is a point of the curve at all, and of which order, was not checked here. One spendable
   dead output is one stolen unclaimed Mordinal.
4. **Original-rules indexers and the text.** After a burn the original rules show the claim
   text as the Mordinal's current text and the burn output as its holder. Nobody is known to
   run such an indexer today, and the rules here do not consult one. An indexer that follows
   the original rules more loosely or more strictly than their source (for example one that
   reads `tx_extra` differently) may disagree about single transfers.
5. **The added entry #42,894** (the video in a mining reward transaction) is on this
   ledger's owner list and unknown to the original rules. A burn of its owner coin claims it
   here and moves nothing there.
6. **Original-format transfers after the start block that are not burns.** The owner list is
   the one of the start block. Someone who moved a Mordinal the old way after that block
   holds, for the original rules, a Mordinal on an output this ledger does not know; the
   listed owner output is spent, so nobody can burn-claim it.
7. **Relay and wallets.** The relay carries records, not burning transfers: a holder's own
   wallet builds and sends one, and a node asked for its ring sanity check refuses it
   (`send_raw_transaction` has to be called with `do_sanity_checks: false`). No wallet screen
   is in this repository. Whether the 2023 wallet still runs against today's network was not
   tested; its transfers are the same shape as the one the rule reads.
8. **Waiting burns.** `/pending` and the "waiting" notices show records only; a burning
   transfer that waits for a block is not shown.
9. **A mainnet reader with other dead outputs.** `--burn-dead` exists for test chains. On
   mainnet it makes another ledger (the folder and the checkpoints say so) but nothing stops
   it.

## For a reviewer: attack these first

1. **The ring rule** (`movedOutput` in `burn.mjs`). Can a transaction be read as a burn of a
   Mordinal here and as a transfer of another output, or of none, by the original rule? Can
   an input that the original rule takes be passed over here, or the other way round?
   Amount-0 inputs only: is there an output index space the rule confuses?
2. **The strict `tx_extra` reader** (`readTransfer`) against `parse_tx_extra` of the original
   source. Any byte string this reader accepts that the original parser reads differently
   (another first `0x11` field, a `0x10` field, a parse that stops early) breaks the promise
   that an accepted claim is a burn for the original rules.
3. **`hash_to_ec` and the burn address** (`hashToPoint`). It passes the first 32 cases of
   Monero's own test file in the tests and passed all 256 when it was written; the burn
   keys equal the ones the tool derives with another library. Is the spend key really a
   point nobody can have a secret key for?
4. **Output 0 and the burn address** (`paysBurnAddress`). Can a transaction pass this check
   while a wallet holding some other key can spend output 0?
5. **The owner output index.** The claim names a Mordinal by `ownerOutputIndex`, a field the
   owner-list hash never covered. The second hash pins it for a burning ledger; the indexes
   themselves come from the ownership index and were not checked again against a node here
   (only the one in the mainnet fixture was).
6. **Reader state.** A folder taking the setting in before the first burn block; a replaced
   block that held a burn; the journal rebuilt without a node; `verify.mjs` on a log with
   burns. Can two readers on one chain end with different owners?
7. **The fee rule.** The transaction's fee as the node reports it (`txnFee`) against the
   original `get_inscription_record_cost`. The original applies the fee rule from block
   2,855,400; this rule always.
