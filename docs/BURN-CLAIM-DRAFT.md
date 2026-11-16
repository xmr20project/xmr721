# Claiming by burning: draft (15 November 2026; the fee added 16 November)

Status: a local candidate. No ledger uses it and nothing here is switched on. Two reviews inside the project read the first version; what they found is changed and listed below. The fee of burn claims (16 November) has not been reviewed yet. The rule is [`../RULES.md`](../RULES.md) section 10; this page says what was
built, how to try it, what is decided and what is not, and what a reviewer should attack
first.

## The change in one paragraph

Today a Mordinal is claimed by a record that proves control of its owner coin and spends
nothing (RULES.md section 3). With this change a ledger can name a **first burn block**.
From that block on a Mordinal is claimed by **burning it**: a transfer in the original 2023
Mordinals format whose ring is the owner coin and the fifteen dead outputs, whose output 0
pays an address nobody can spend from, and whose text is `xmr721 claim to <address>`. Under
the original rules the old Mordinal then sits on an unspendable output; here it belongs to
`<address>`, once its fee is paid: the burn transaction's own fee once more, paid to the
Mordinal's own fee address (the project fee wallet's subaddress at account 1, index = the
Mordinal's number). Until then the Mordinal is burned and waits for its fee. Claim records
still count for 720 blocks from the first burn block and are refused after that.

## What was built

| Where | What |
|---|---|
| `rules/lib/burn.mjs` | Monero's `hash_to_ec`, the burn address and its public view key, the dead outputs, the strict reading of `tx_extra`, the text, the ring, the transaction fee, the check that output 0 pays the burn address (with the transaction key, or the additional key of output 0) |
| `rules/lib/burn-fee.mjs` | the fee wallet (main address and public view key), the fee address of each Mordinal (subaddress (1, n)), the table of their spend keys, `feeParts` (what the rule reads of a transaction) and `feeOutputs` (the outputs that pay a fee address, as wallet2 finds them, amounts checked against commitments) |
| `rules/lib/ledger.mjs` | `burnFrom`, `burnDead` and `burnFee` in the setup; `checkBurnClaim` / `applyBurnClaim` (a valid burn waits until its fee is paid); `scanBurnFees` / `applyBurnFees`; `burnClaim(id)`, `burnFee(n)`; claim records refused from the first burn block plus 720 on |
| `reader/lib/reader.mjs` | finds original-format transfers from the first burn block on, journals each (accepted, or refused with the reason); scans every transaction from that block on for fee payments and journals those that pay a fee address; rebuilds from the journal, undoes both when blocks are replaced; the setting (with the fee wallet) is part of the folder's identity and of checkpoints from that block on |
| `reader/lib/owners.mjs` | a second hash, over each entry's owner output index, which the owner-list hash does not cover |
| `reader/service.mjs` | `--burn-from`, `--burn-dead`, `--burn-fee-wallet`; `/info` (`burnFrom`, `burn` with `fee`), `/burns` (burn claims and fee payments), `/entry/<txid>` (a burn's state and fee; what each fee payment counted for), `/status/<id>` (`waiting`), `/mordinal/<n>` (`ownerOutput`, `burnFee`, `waiting`), `/owners` (`ownerOutputIndex`), `/records`, `/stats` |
| `reader/tools/verify.mjs` | replays logged burn claims and fee payments, compares their parts with the node, checks the setting (with the fee wallet) in checkpoints |
| `reader/views/` | the XMR721, Mordinal and About pages explain the burn and its fee when `/info` reports it, with a burn address, a text, a fee wallet and fee addresses they work out from the rule library themselves; a Mordinal whose burn waits shows what is missing and where to pay; unchanged otherwise. The pages have no QR helper, so the fee address is shown as text with a copy button |

A reader without `--burn-from` does what it did: same journal, same folder, same checkpoints,
same answers. This was compared byte for byte against the code before the change on one
made-up chain holding records, mints, burning transfers and a replaced block, and again
after the fee was added (against `ef7ee41`) on a chain that also holds fee payments alone,
beside other payments and inside burning transfers: the four state files after every block
and 76 service answers were equal (with a comparison script kept outside this repository).

## Trying it

```
npm test                    # includes rules/tests/burn.test.mjs and reader/tests/burn.test.mjs
npm run test:views          # includes reader/tests/burn-views.test.mjs
MONERO_BIN=… MORDINAL_OLD=… node --test reader/tests/lab-burn.test.mjs
```

`rules/tests/fixtures-burn.json` holds one real pair of mainnet transactions: a registration
in the original format (block 3,806,656) and the transfer of its owner output to the burn
address (block 3,806,759). The rule accepts the pair as a valid burn claim; no fee was paid
for it, so the Mordinal waits (a made-up payment then completes it). That inscription is not
on the ledger's owner list, so the test puts it on a list of its own. The file also holds
fee addresses as monero-wallet-rpc 0.18.5.3 lists them for a view-only copy of the fee wallet
(account 1, indexes 0 to 50,000; 14 of them are kept).

The lab test runs a real registration and a real burning transfer on a private chain, built
by a separate tool that is not in this repository (`MORDINAL_OLD` names its binary), and
has the reader accept the transfer from a real node: the Mordinal waits for its fee. A
monero-wallet-rpc wallet then pays the fee (alone, and beside another payment with
additional keys, one piconero short and then the rest) and the reader gives the Mordinal to
the address in the text. A view-only copy of the fee wallet in monero-wallet-rpc, with the
lookahead of the operator note, lists the same payments at the same subaddresses with the
same amounts. Without the tool it is skipped (passed on 16 November, about 40 seconds).

To switch a reader on: `--burn-from <height>`. A state folder takes the setting in when it
is restarted with it, as long as that block is at least 10 blocks above the newest block
the folder has read. Until the folder has read the block, the height can be corrected or
the setting taken out again the same way (a new height again 10 blocks above what was
read). A folder that has read its first burn block keeps it: another one is another ledger,
read again from the start block.

## Decided in this draft (each can be argued with)

1. **`tx_extra` is read more strictly than the original parser reads it**: at most 1,060
   bytes, and only a public key, a nonce, additional keys and exactly one `0x11` field.
   Whatever passes, the original parser reads the same way. The price: a transfer with padding or another field moves the
   Mordinal under the original rules and claims nothing here, and its coin is spent. The
   original wallet's transfers do not look like that: 100 of the 165 transfers of 2023 were
   read with this parser, all pass, all have the layout `01 02 11`.
2. **The first ring the original rule would take decides.** A transaction with two such
   rings claims only by the first, as the original moves only by the first.
3. **70499745 is not dead.** A ring with it claims nothing here and still moves the Mordinal
   for the original rules.
4. **Output 0 is found with the transaction key or with the additional key of output 0**, as
   a wallet looks for it (changed 16 November: a burn that also pays its fee to a subaddress
   carries additional keys, and some wallet libraries give every output its own key). The
   additional keys are those of the first `04` field before the transfer field: wallet2
   stops reading `tx_extra` at the transfer field.
5. **The view tag of output 0 must be right** when it has one, so a view-only wallet of the
   burn address sees every burn. The amount is not looked at (the tool pays 1 piconero).
6. **The text is exact but for one line end**: after the address nothing, or one `\n` or
   `\r\n`. No integrated address, the ledger's network only. Of the 20 transfers of 2023
   (among 100 looked at) that carry a text, 13 end in a line break, and both wallets read the
   text from a file: without this a careful holder would lose the Mordinal to a text editor.
7. **The dead outputs and the owner output indexes are part of the ledger's identity**: the
   state folder and, from the first burn block on, every checkpoint name them. On mainnet
   the dead outputs are fixed; a reader with a list of its own reads only from a node of the
   offline test chain, and the check tool believes such a service only there. Every owner
   list entry has to state its output index, or a ledger with the setting does not open.
8. **Every original-format transfer from the first burn block on is journaled**, also one
   that has nothing to do with XMR721, so `/entry/<txid>` can say why a burn did not count.
9. **The id of a burn claim** (what `/status/<id>` and events carry) is
   `SHA-256("XMR721-BURN-CLAIM-v1" 0x00 ‖ domain ‖ txid)`.
10. **Claim records stop 720 blocks after the first burn block**, one fixed number
    (`RECORDS_OVERLAP`), not a setting. A burn that reached a block before the first burn
    block, by being sent early or by a reorganisation, claims nothing; its holder then still
    has about a day to claim by record with the one-time key. In the overlap the first valid
    claim wins. The relay stops carrying claim records one block before they stop counting.
11. **Burn claims have a route of their own.** `/records` stays what it was (MD1 records);
    `/burns` lists the accepted burn claims with `before`, the number of records that come
    before each, so a client can replay both in ledger order.
12. **The pages do not take the burn address, the fee wallet or a fee address from the service.** They work it out with the
    rule library and show no instructions when `/info` states another address or text. The
        XMR20 wallet is named only when the page's `index.html` carries
    `<meta name="xmr721-wallet-burn" content="yes">`; it is not there.

Added 16 November, the fee (RULES.md section 10, "The fee"):

13. **The fee is the burn transaction's own `txnFee`**, paid once more to the Mordinal's fee
    address, the project fee wallet's subaddress (1, n). The wallet and its view key are
    mainnet constants next to the burn address; another wallet only off mainnet or on the
    offline test chain (`--burn-fee-wallet`).
14. **A burn completes at the first place where the valid burn and enough fee are both on the
    chain**: at the burn, when the fee was paid before or is paid by its own outputs; else at
    the payment that reaches the amount. Within one transaction the record or burn comes
    first, then its fee payments. The claim event and the history carry that place, with
    `burnHeight` and `feeTx` when it is a later payment.
15. **A waiting burn holds its Mordinal**: a second burning transfer of it is refused. A claim
    record in the overlap is not: the first claim that completes wins, and the waiting burn
    is then lost. Fee payments for a claimed Mordinal, or one without a valid burn, are kept
    and give nothing; a later valid burn uses earlier payments.
16. **A fee payment is found as wallet2 finds it, and no other way**: the first transaction
    public key and the first list of additional keys up to the first field a wallet does not
    know; view tags respected; the amount checked against the commitment; no lock time; the
    block reward transaction not looked at. A one-time key counts once, at the largest amount
    seen with it (a wallet keeps the larger of two such outputs; the view key is public, so a
    copy of a payment's key is easy to make).
17. **Fee payments are journaled facts.** Every transaction from the first burn block on that
    pays a fee address gets `fee` (what `feeParts` reads) in its entry, or an entry of its own.
    They count in a checkpoint's `records` and `listHash`, and the ledger summary under it
    gains `waiting` and `fees` once there is something to say. The state folder's schema name
    ends in `-burn-fee`, so code from before the fee refuses such a folder.

## Not decided

1. **Holders whose owner coin is already spent.** An owner coin that an ordinary wallet
   spent as money (many 2023 wallets could do that without noticing) cannot be spent again,
   so its Mordinal cannot be claimed by burning. Such a holder can claim with proof 0 or
   proof 1, which need the keys and not the coin, until claim records stop (720 blocks after
   the first burn block). After that this draft leaves them **no way**. The same holds for
   a holder whose burn was refused. How many of the 42,894 owner coins are spent is not
   known and cannot be read from the chain (their rings are ordinary). A fallback would
   bring back exactly the claim this change removes, for anyone who says the coin is spent;
   whether a spent coin can be shown (a key image with a proof of spend) was not designed.
2. **The one Mordinal claimed before the rule, #42,875.** It stays claimed by its record.
   Its old Mordinal is not burned: under the original rules it still sits on its owner coin
   and can be moved there. Nothing here asks its owner to burn it afterwards, and a later
   burning transfer of it is refused as "already claimed" (and would still move it for the
   original rules). The same holds for any claim accepted before the first burn block.
3. **The dead key.** All fifteen dead outputs carry one key, the `dead_key` constant of the
   original source (`deadbeef…dead000f`). It decodes to a point of the main group, and
   nobody chose a secret for it; finding one is the discrete logarithm problem. Because the
   fifteen share the key they share the key image, so a break would allow one theft in
   total. 70499745 is the ordinary sixteenth output of the same transaction and may be
   spendable by whoever made it; that is why it is left out, and why a ring with it claims
   nothing here. Who made that transaction is not known. For the original rules such a ring
   still moves a Mordinal.
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
   transfer, or a fee payment, that waits for a block is not shown. (A burn that is in a block
   and waits for its fee is shown.)
9. **The length of the overlap.** 720 blocks is a choice. Longer leaves the old claim open
   longer; shorter leaves less time to a holder whose burn was mined early.
10. **`/records` carries no heights.** A client that replays `/records` and `/burns` gets
    the order, not the block of each entry; `/log` has both. Unchanged from before.
11. **No refunds, and a fee that moves with the network.** A fee paid without a burn, for
    another Mordinal, beyond what is due, or for a burn that a record overtook stays with the
    project. The amount due is the burn's own fee, so it follows the network's fee level; the
    pages ask 0.0012 XMR before the burn is known. Whether to return mistaken payments by hand
    is not decided.
12. **What the fee makes public.** Anyone with the published view key sees every fee payment,
    its amount and the Mordinal it is for; the paying transaction is linked to that claim.
13. **The reader's cost.** Every transaction from the first burn block on is scanned: about
    1.4 ms per transaction, 48 ms per mainnet block on average (at most 176 ms of 60 blocks
    measured), and 3.1 s once for the table of the 42,895 fee addresses, on an Apple M4 Pro
    with Node 24. A reader catching up a year of blocks would spend about 3.5 hours on it.
    Not optimised (a native scan, or worker threads, would cut it).
14. **The fee wallet's lookahead.** The fee wallet sees the fees only with a lookahead of at
    least 50,000 addresses in account 1 (reader/README.md, operator note); a payment it does
    not see still counts here.
15. **Wallets that put the fee into the burn.** A wallet that pays the fee address inside the
    burning transfer has to write the additional keys (`04`) before the transfer field
    (`0x11`): a wallet, and this rule, stop reading `tx_extra` at the transfer field, so keys
    after it find neither output 0 nor the fee output.

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
   owner-list hash never covered. The second hash pins it for a burning ledger, and `/owners`
   serves the index so the hash can be recomputed; the indexes themselves come from the
   ownership index and were not checked again against a node here (only the one in the
   mainnet fixture was).
6. **Reader state.** A folder taking the setting in, changing it or dropping it before the
   first burn block is read; the overlap, where a record and a burn of one Mordinal can meet
   in one block; a replaced block that held a burn; the journal rebuilt without a node; `verify.mjs` on a log with
   burns. Can two readers on one chain end with different owners?
7. **The fee rule.** The transaction's fee as the node reports it (`txnFee`) against the
   original `get_inscription_record_cost`. The original applies the fee rule from block
   2,855,400; this rule always.
8. **The fee scan** (`feeOutputs` in `burn-fee.mjs`) against wallet2's `is_out_to_acc_precomp`
   and `cache_tx_data`: can an output count here that the fee wallet cannot find or spend, or
   the other way round? Known differences, all stricter here: wallet2 tries every `01` field,
   and reads on past merge-mining (`03`) and `0xde` fields; this rule takes the first `01` and
   stops there. Point decoding differs at the edges (non-canonical encodings).
9. **Completion and order** (`complete`, `applyBurnFees` in `ledger.mjs`, `judgeFees` in
   `reader.mjs`): a burn and payments in one block, in one transaction, before the burn,
   split across blocks, replaced blocks; the largest-amount rule for repeated one-time keys
   (it can only grow, so a payment never takes back a completed claim). Can two readers
   disagree about the block a claim completes in?
10. **The waiting state against claim records** in the overlap, and a waiting burn that holds
    its Mordinal against a dead-key break.

## Changed after the first two reviews

| Found | Change |
|---|---|
| A text ending in a line break was refused; real transfers often end that way | one `\n` or `\r\n` after the address is taken |
| A burn mined before the first burn block was lost for good | claim records count 720 blocks longer, so the one-time key still claims |
| A large `tx_extra` was journaled and its text turned into a string with a call that can fail | above 1,060 bytes it is no transfer and is not journaled; the text is read byte by byte, and only when it is short enough to be a claim |
| `--burn-dead` worked on mainnet | fixed list on mainnet; own list only on the offline test chain (the node has to say so) and on other networks |
| An owner list entry without an output index could never be burn-claimed, silently | the ledger does not open |
| A mistyped first burn block could not be corrected, and one right above the tip was taken | changed or dropped until either block is read; at least 10 blocks above the folder's tip |
| A client replaying `/records` missed burn claims; the output indexes were not served | `/burns` with `before`; `/owners` gives `ownerOutputIndex` on a burning ledger |
| The pages showed whatever burn address the service stated, and named a wallet button that does not exist | the pages work the address out themselves; steps for the original wallet; the XMR20 wallet only by a meta tag |
| The dead outputs were described as fifteen unknown keys | one shared key, one possible theft; 70499745 is the transaction's ordinary sixteenth output |
