# Mordinals by signature — rule document (draft 3)

Status: draft. Not final, not independently reviewed, not in use anywhere.
The code in `rules/lib/` is these rules; `rules/tests/fixtures.json` holds test cases any
other implementation can replay. Values marked **draft** can still change before review.

## 1. What the rules decide

From the start block, a Mordinal is owned by a Monero address. The ledger is worked out from
three public inputs only:

1. **The owner list at the start block**: one entry per Mordinal under the original rules
   (registration transaction, owner transaction, the key of its output 0, its view tag and
   its transaction public key). Format: `ownership-index/result/owners.jsonl`. Entries
   added by this ledger follow the original ones (`ownership-index/added/added.jsonl`):
   so far one, the video inscribed in the mining reward transaction of block 3,799,494.
2. **Records** in Monero transactions (`tx_extra`), read in chain order.
3. **Payment transactions** named by buy records, as any Monero node returns them.

Nothing else counts: no server database, no off-chain agreement. Two readers given the same
chain reach the same owners.

Fixed per ledger: the 32-byte domain (separates this ledger from any other use of the same
keys), the network, the protocol fee address, the start block.

## 2. Records

```
record  = "MD1" 0xfe  op(u8)  body  [proof or signature]
address = kind(u8: 0 standard, 1 subaddress)  spend key(32)  view key(32)
numbers are little-endian; u32 = block or counter, u64 = piconero, u16 = basis points

op 1 claim    reg32 ownerTx32 to proof(u8) [holder when proof = 1]
              proof 0: c32 r32
              proof 1: D32 pc32 pr32   variant(u8) c32 r32
op 2 move     reg32 seq(u32) from to                                variant c32 r32
op 3 list     reg32 seq(u32) until(u32) price(u64) seller           variant c32 r32
op 4 cancel   lot32 seller                                          variant c32 r32
op 5 reserve  lot32 payBy(u32) buyer rate(u16) [market when rate>0] variant c32 r32
op 6 buy      lot32 n(u8: 2 or 3) n × (txid32 out(u8) D32 c32 s32)     (no signature)

id   = SHA-256("MORDINALS-RECORD-v1" 0x00 ‖ domain ‖ "MD1" 0xfe ‖ op ‖ body)
code = the first 16 bytes of id, shown as 32 hex characters
lot  = the id of a list record
```

A record must decode exactly: no spare bytes, known op, valid keys, canonical scalars.
An address is refused when no wallet could use its keys (a spend or view key outside the
main group, or the neutral point).
A record whose id is already on the ledger is ignored. A record that fails any check is
ignored and changes nothing.

Largest sizes seen in the tests: claim 199 bytes (one-time key) or 361 (payment proof),
move 236, list 183, reserve 238, cancel 167. A buy record is 296 bytes (seller and
protocol fee) or 425 bytes (with a marketplace fee). Monero relays at most 1,060 bytes of
`tx_extra`.

### Signed texts

Every signed record is a wallet "sign message" signature (wallet2 SigV2, **spend key**) over
one line of text that the record's bytes fully determine. A signature made with the view key
is refused. Wallets differ in how they end the text they sign; `variant` says which ending
was signed: 0 nothing, 1 a line feed, 2 a carriage return and a line feed. Any other value
is refused.

```
Mordinals claim: Mordinal #N (inscription <reg>), held by output 0 of <ownerTx>, now belongs to <to>; code <code>
Mordinals move: send Mordinal #N to <to>; move <seq>; code <code>
Mordinals list: sell Mordinal #N for P XMR (<P − fee> XMR to <seller>, <fee> XMR protocol fee); valid until block <until>; code <code>
Mordinals cancel: stop selling Mordinal #N; listing <lot code>; code <code>
Mordinals reserve: buy Mordinal #N for P XMR; pay exactly <a> XMR to <seller> and exactly <b> XMR to <fee address>[ and exactly <c> XMR to <market>] by block <payBy>; Mordinal to <buyer>; code <code>
```

The reader rebuilds the text from the record, so what the person read in their wallet is
what the ledger applies.

## 3. Claim (once per Mordinal)

The first valid claim for a Mordinal wins. `ownerTx` must be the owner transaction on the
owner list. The Mordinal then belongs to `to`. Claims have no deadline.

The owner coin is output 0 of the owner transaction, with one-time key `P` and transaction
public key `R`.

**Proof 0 — one-time key.** A Schnorr signature under `P`:

```
x = Hs(8·a·R ‖ varint 0) + b (+ subaddress scalar)        P = x·G
h = keccak256("MORDINALS-CLAIM-KEY-v1" 0x00 ‖ domain ‖ claim body)
R' = k·G     c = Hs(h ‖ P ‖ R')     r = k − c·x           accepted when Hs(h ‖ P ‖ r·G + c·P) = c
```

It shows nothing new: `P` is already on the owner list. No address, no amount, no key image.

**Proof 1 — payment proof and message (any wallet that signs messages: Feather, Cake
Wallet, Monero CLI, wallet RPC).** Two parts:

- a wallet2 `InProofV2` for the owner transaction and the holder's address, made with an
  **empty message**, covering exactly one transaction key;
- a "sign message" signature by the same address (spend key) over the claim text.

```
D = a·R      prefix = keccak256(ownerTx ‖ message)
X = c·V + r·(G, or B for a subaddress)      Y = c·D + r·R
accepted when Hs(prefix ‖ D ‖ X ‖ Y ‖ keccak256("TXPROOF_V2") ‖ V ‖ R ‖ (B for a subaddress, else 32 zero bytes)) = c
and P = Hs(8·D ‖ varint 0)·G + B
```

The signature is required because a payment proof needs only the view key. An address that
was paid by another output of the same transaction does not hold the Mordinal.

The rules do not care who made the payment proof, only that it is valid. It can come from
the wallet (`get_tx_proof`; in Feather from a view-only copy when the wallet sent the owner
transaction itself), or from any tool that holds the private view key
(`inProofFromViewKey` in `lib/claim.mjs`), for wallets that show the view key but make no
such proof. The message signature must always come from the spend key.

Proof 1 is public and shows more than proof 0: the holder's address, and `D`, from which
anyone can read the **amount** of the owner coin. It shows no key image and spends nothing.

Never accepted: OutProofs, spend proofs, reserve proofs, key images, any spend of the owner
coin.

## 4. Move

`from` must own the Mordinal, `seq` must equal the Mordinal's counter, and the Mordinal must
not be listed. The counter starts at 0 after the claim and goes up by one on every move,
sale and cancel, so a signed record can be used once and never replayed after the Mordinal
comes back to an earlier owner.

## 5. Trade

1. **List.** The seller (current owner, right `seq`, not already listed) signs a price and a
   last block. Lowest price 0.001 XMR. The fee address cannot sell.
2. **Reserve.** A buyer signs a reservation naming the address that receives the Mordinal
   and a last block to pay by (`payBy`): at most 30 blocks ahead and not after the listing
   ends. The reservation holds the listing until block `payBy + 10`: until then nobody
   else can reserve it and the seller cannot cancel it. The seller cannot reserve.
3. **Pay.** The buyer pays from any wallet, in one to three transactions. Each payee gets
   its exact amount as one output.
4. **Buy.** The buyer's wallet makes the buy record: for each payee the payment's
   transaction id, the number of the output that pays it, and a proof made with the
   payment's transaction key. The key itself is not in the record. Anyone may post the
   record. The Mordinal moves to the reservation's address. The seller is not needed.
5. **End.** After block `payBy + 10` the listing is free again. The ten blocks are the
   time a payment made by `payBy` has to reach a block and be recorded. An expired listing
   must be cancelled before the Mordinal can move or be listed again.

A reservation is refused when one of its payee lines (address and exact amount) equals a
line of any reservation, running or run out, on a listing that is still open and has not
ended (the same listing included). Lines of reservations that ran out stay taken so that a
payment made for one of them can never fit another buyer's reservation. Reserving again a
few blocks later gives other amounts.

### Amounts

```
tail      = 1 + (first 8 hex characters of the reservation code, as a number, mod 999,999)   piconero
fee       = floor(price × 500 / 10,000)                     the protocol fee, 5%
seller    receives exactly  price − fee + tail
fee address receives exactly  fee + tail
marketplace (optional) receives exactly  floor(price × rate / 10,000) + tail
```

The tail ties each payment to one reservation, so a payment cannot be claimed for another
sale. A marketplace fee is paid on top of the price, to an address named in the reservation
that differs from the seller and the fee address; rate at most 500 basis points.

### Payment proof

Entry `i` of a buy record belongs to payee `i` of the reservation: seller, protocol fee
address, then the marketplace when the reservation names one. An entry is
`txid, out, D, c, s`:

```
r        the transaction key that made output `out` (the additional key of that output
         when the transaction carries one key per output), known to the payer only
V, B     the payee's view and spend public keys
Base     G for a standard address, B for a subaddress
R        r·Base, the public key the transaction carries for that output
D        r·V, the shared secret
message  "mordinals-payment:" domain ":" listing id        (both as 64 hex characters)
proof    k random;  X = k·Base;  Y = k·V
         c = Hs( keccak256(txid ‖ message) ‖ D ‖ X ‖ Y ‖ keccak256("TXPROOF_V2") ‖ R ‖ V ‖ (B for a subaddress, else 32 zero bytes) )
         s = k − c·r
check    X' = c·R + s·Base;  Y' = c·D + s·V;  the same hash over X', Y' gives c
```

This is the proof Monero wallets make as an "OutProofV2" for one transaction key
(`get_tx_proof` with the message above). It shows that one key made both `R` and `D`.
With `D` the output is opened like the payee's wallet opens it: output key
`Hs(8·D ‖ out)·G + B`, view tag, amount and commitment. `D`, `R`, `V` and `B` must be
points of the main group and not the neutral point; `c` and `s` must be below the group
order. The same holds for the keys of the fee address: a ledger whose fee address has a
key no wallet can use is refused as a whole.

The output number and, for a standard address, the spend key `B` are not part of the hash.
Both are fixed by the output check: with another number or another key the output key
does not come out, and the record is refused.

`k` must never be used for two different proofs with the same `r`: that would give away
`r`. A signer takes `k` from fresh random bytes hashed together with `r` and everything
the proof covers (transaction id, message, `D`, `R`, `V`), so a weak or repeated random
source still gives a different `k` for a different proof.

The proof is bound to the transaction id, the ledger and the listing. Whoever reads a buy
record learns `D` and can copy the output key into another transaction that repeats `R`,
but cannot make a proof for that transaction, so a copy never counts as a payment. A
second proof of the same payment is a different record with the same effect.

### Buy checks

- The buy is checked against the **latest** reservation of the listing. A payment made after
  `payBy` still counts while that reservation is the latest and the listing is neither
  cancelled nor ended; once someone else has reserved, it is lost. A payment in a block
  after the listing's last block never counts. Wallets and marketplace pages must refuse to
  pay late.
- A buy record has one entry per payee, in the reservation's order: two entries, or three
  with a marketplace fee. Fewer or more: refused.
- Every payee is paid its exact amount by **one output**: the output its entry names. An
  amount split over several outputs, more, less or missing: refused.
- A payment counts only if the payee's wallet would find it as one coin it can spend:
  - the transaction has no lock time;
  - `tx_extra` holds the transaction public key, a nonce and the list of additional keys
    at most; anything else ends the reading, and so does a length written in more bytes
    than it needs (Monero's reader refuses it). Keys after that are not used, as in
    wallet2. Without a transaction public key nothing in the transaction counts, also not
    an output found through an additional key: a wallet skips such a transaction;
  - the first transaction public key is a point of the main group and not the neutral
    point. Otherwise nothing in the transaction counts, also not an output found through
    an additional key. This is stricter than a wallet, which may still find such an
    output; no wallet makes such a transaction;
  - the entry's proof holds for a public key the transaction carries where a wallet looks
    for it: the first transaction public key, or the additional key of that output when
    the transaction carries exactly one additional key per output;
  - the output key fits the payee's address, the view tag is right and the amount fits the
    output's commitment.
- Each payment transaction is in a block, not before the reservation and not after the buy
  record. A transaction counts for one sale only.
- A coin counts for one sale only: an output key paid to the same address a second time
  does not count, because the wallet can spend only one of the two. The same output key at
  a different address is a different coin and is judged on its own.

Draft 2 put the payment's transaction key in the buy record. With that key anyone could
make a second payment to the same payee that repeats the output key and, by getting a
purchase of their own recorded first, have the first buyer's record refused. A buy record
therefore carries proofs and no key.

## 6. Privacy rules

1. No record contains or requires a key image.
2. No record requires a transaction with chosen ring members. Every transaction is made by a
   standard wallet with normal rings.
3. No reserve proofs, no spend proofs.
4. A buy record names only the outputs that pay the seller and the fee addresses. It
   carries no transaction key.
5. Records fit the standard `tx_extra` limit.
6. The owner coin is never spent by these rules. After the claim it is an ordinary coin.

What becomes public: owner, seller and buyer addresses (as with XMR20 NFTs); sale prices;
with proof 1, the holder's address at the owner transaction and the owner coin's amount.

What a purchase makes public, for good:

- the transaction id of each payment and which of its outputs paid the seller and each fee
  address, with their amounts, tied to the buyer's address in the ledger;
- the shared secret `D` of each of those outputs. With `D` anyone can open exactly that
  output, as the payee can. It opens no other output and gives no way to spend;
- by elimination, the buyer's change: in a payment with two payees and one more output,
  that output is the buyer's change coin. Observers then know one coin of the buyer's
  wallet and can follow it as a known ring member when it is spent later.

The inputs of the payment stay hidden behind their rings as in any Monero transaction. A
buyer who wants no link between the purchase and the rest of a wallet pays from a wallet
kept for that.

## 7. Values

| Value | Setting | Where | State |
| --- | --- | --- | --- |
| Protocol fee | 5%, Mordinals only | `RULES.feeBps` | decided |
| Marketplace fee cap | 5% on top | `RULES.marketFeeCapBps` | decided |
| Lowest price | 0.001 XMR | `RULES.minPrice` | decided |
| Reservation length | at most 30 blocks | `RULES.maxReserve` | decided |
| Time to record a paid purchase | 10 blocks after the pay-by block | `RULES.settle` | draft |
| Entries per buy | 2 or 3, one per payee, from 1 to 3 transactions | `RULES.maxPayments` | decided |
| Claim deadline | none | — | decided |
| Old-style transfers after the start block | not honoured | owner list | decided |
| Payment-proof claim (proof 1) | kept; wallets warn what it shows | section 3 | decided |
| Buy record size | 296 or 425 bytes | record format | decided |
| Domain, fee address, start block | test values only | ledger setup | open |

## 8. How records travel

A record counts only when it is in a Monero block at or after the start block.

```
tx_extra = 01 <transaction public key 32>  [02 09 01 <payment id 8>]
           then per chunk: 02 <length> 7f <chunk>
```

- The record is cut into chunks of 254 bytes; only the last may be shorter and none is
  empty. A transaction carries a record only if its whole `tx_extra` parses exactly this
  way, is at most 1,060 bytes, and the joined chunks start with `"MD1" 0xfe` and are at
  most 1,000 bytes. Anything else is not a record and is skipped.
- One transaction carries one record. Who made the transaction and what it pays do not
  matter: a record stands on its own signature or payments, so anyone can carry it. A
  relay carries records for wallets that cannot build such a transaction themselves; it
  cannot change a record.
- Records are applied in chain order: by block, then by the transaction's position in the
  block. A record that fails a check changes nothing, wherever it is.
- A buy record names payments that must be in a block and not after the buy record
  (section 5). A relay holds a buy record until its payments are in a block.
- When blocks are replaced, records in the replaced blocks are undone and the records of
  the new blocks applied; the result depends only on the chain.

Reader and relay: `reader/`.

Not in this draft: the collection and mint records for new Mordinals and the collection
fee.
