# XMR721 — rule document (draft 4)

Status: draft. Not final, not independently reviewed, not in use anywhere.
The code in `rules/lib/` is these rules; `rules/tests/fixtures.json` holds test cases any
other implementation can replay. Values marked **draft** can still change before review.
Section 10 (claiming by burning) is a draft of a setting that no ledger uses yet.

This draft covers the Mordinals collection. Byte strings inside records (`"MD1"`,
`MORDINALS-RECORD-v1`, `MORDINALS-CLAIM-KEY-v1`, `mordinals-payment:`) and the texts a
wallet signs name Mordinals, because these records are about Mordinals; they are fixed
identifiers, not the name of the standard.

## 1. What the rules decide

From the start block, a Mordinal is owned by a Monero address. The ledger is worked out from
three public inputs only:

1. **The owner list at the start block**: one entry per Mordinal under the original rules
   (registration transaction, owner transaction, the key of its output 0, its view tag and
   its transaction public key; and the global index of that output, which only section 10
   reads). Format: `ownership-index/result/owners.jsonl`. Entries
   added by this ledger follow the original ones (`ownership-index/added/added.jsonl`):
   so far one, the video inscribed in the mining reward transaction of block 3,799,494.
2. **Records** in Monero transactions (`tx_extra`), read in chain order. On a ledger with a
   first burn block (section 10) also the transfers in the original Mordinals format from
   that block on.
3. **Payment transactions** named by buy records, as any Monero node returns them.

Nothing else counts: no server database, no off-chain agreement. Two readers given the same
chain reach the same owners.

Fixed per ledger: the 32-byte domain (separates this ledger from any other use of the same
keys), the network, the protocol fee address, the start block, the first block at
which new NFTs can be made (section 9; without it the ledger holds Mordinals only), and the
first block from which Mordinals are claimed by burning (section 10; without it they are
claimed by record, as in section 3, for good).

## 2. Records

```
record  = "MD1" 0xfe  op(u8)  body  [proof or signature]
address = kind(u8: 0 standard, 1 subaddress)  spend key(32)  view key(32)
numbers are little-endian; u32 = block or counter, u64 = piconero, u16 = basis points

op 1 claim    reg32 ownerTx32 to proof(u8) [holder when proof = 1 or 2] [spendTx32 keyImage32 when proof = 2]
              proof 0: c32 r32
              proof 1: D32 pc32 pr32   variant(u8) c32 r32
              proof 2: D32 pc32 pr32 kc32 kr32   variant(u8) c32 r32   (section 11)
op 2 move     reg32 seq(u32) from to                                variant c32 r32
op 3 list     reg32 seq(u32) until(u32) price(u64) seller           variant c32 r32
op 4 cancel   lot32 seller                                          variant c32 r32
op 5 reserve  lot32 payBy(u32) buyer rate(u16) [market when rate>0] variant c32 r32
op 6 buy      lot32 n(u8: 2 or 3) n × (txid32 out(u8) D32 c32 s32)     (no signature)
op 7 collection  creator max(u32) flags(u8: 0) name(len u8, 1–64)     variant c32 r32
op 8 mint     collection32 edition(u32) creator flags(u8) [to]
              name(len u8, 0–64) type(u8) content(len u16, 1 or more)
              [origin: kind(u8) ref(len u8, 1–64)]                    variant c32 r32
op 9 burn     nft32 seq(u32) owner                                  variant c32 r32
op 10 offer   bidder price(u64) until(u32) count(u16) kind(u8) ref32
              rate(u16) [market when rate>0]                        variant c32 r32   (section 13)
op 11 accept  offer32 reg32 seq(u32) seller n(u8) n × hash32        variant c32 r32
op 12 withdraw offer32 bidder                                       variant c32 r32

id   = SHA-256("MORDINALS-RECORD-v1" 0x00 ‖ domain ‖ "MD1" 0xfe ‖ op ‖ body)
code = the first 16 bytes of id, shown as 32 hex characters
lot  = the id of a list record
```

A record must decode exactly: no spare bytes, known op, valid keys, canonical scalars.
An address is refused when no wallet could use its keys (a spend or view key outside the
main group, or the neutral point).
A record whose id is already on the ledger is ignored. A record that fails any check is
ignored and changes nothing.

Largest sizes seen in the tests: claim 199 bytes (one-time key), 361 (payment proof) or 489
(spent coin, section 11), move 236, list 183, reserve 238, cancel 167. A buy record is 296 bytes (seller and
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
Mordinals claim: Mordinal #N (inscription <reg>), held by output 0 of <ownerTx> and spent in <spendTx>, now belongs to <to>; code <code>
Mordinals move: send Mordinal #N to <to>; move <seq>; code <code>
Mordinals list: sell Mordinal #N for P XMR (<P − fee> XMR to <seller>, <fee> XMR protocol fee); valid until block <until>; code <code>
Mordinals cancel: stop selling Mordinal #N; listing <lot code>; code <code>
Mordinals reserve: buy Mordinal #N for P XMR; pay exactly <a> XMR to <seller> and exactly <b> XMR to <fee address>[ and exactly <c> XMR to <market>] by block <payBy>; Mordinal to <buyer>; code <code>
```

The second claim text is the one of proof 2 (section 11). The reader rebuilds the text from
the record, so what the person read in their wallet is what the ledger applies.

## 3. Claim (once per Mordinal)

The first valid claim for a Mordinal wins. `ownerTx` must be the owner transaction on the
owner list. The Mordinal then belongs to `to`. Claims have no deadline.

On a ledger with a first burn block, claim records of proof 0 and 1 count up to 720 blocks
past it and no longer after that; from the first burn block on a Mordinal is claimed as
section 10 says. A ledger may name a block from which they count again
(section 12). A claim record of proof 2 counts only on a ledger that names a first block
of claims by a spent coin, from that block on (section 11). What follows describes proofs 0
and 1.

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

Never accepted as a claim record: OutProofs, spend proofs, reserve proofs. A key image and a
spend of the owner coin count only in proof 2, on a ledger with section 11; the burning
transfer of section 10 claims on a ledger that has it.

## 4. Move

`from` must own the Mordinal, `seq` must equal the Mordinal's counter, and the Mordinal must
not be listed. The counter starts at 0 after the claim and goes up by one on every move,
sale and cancel, so a signed record can be used once and never replayed after the Mordinal
comes back to an earlier owner.

## 5. Trade

1. **List.** The seller (current owner, right `seq`, not already listed) signs a price and a
   last block. Lowest price 0.001 XMR. The last block is at most 21,600 blocks (about 30
   days) after the block of the listing record. The fee address cannot sell.
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
- Each payment transaction is in a block at or after the reservation's block and at or before
  the buy record's block. Only block heights are compared: within one block, the order of
  the payment, the reservation and the buy record does not matter. A transaction counts for
  one sale only.
- A coin counts for one sale only: an output key paid to the same address a second time
  does not count, because the wallet can spend only one of the two. The same output key at
  a different address is a different coin and is judged on its own.

Draft 2 put the payment's transaction key in the buy record. With that key anyone could
make a second payment to the same payee that repeats the output key and, by getting a
purchase of their own recorded first, have the first buyer's record refused. A buy record
therefore carries proofs and no key.

## 6. Privacy rules

1. No record contains or requires a key image.
2. No record requires a transaction with chosen ring members. Every transaction that
   carries a record is made by a standard wallet with normal rings.
3. No reserve proofs, no spend proofs.
4. A buy record names only the outputs that pay the seller and the fee addresses. It
   carries no transaction key.
5. Records fit the standard `tx_extra` limit.
6. The owner coin and claiming. A claim record (section 3) does not spend the owner coin:
   after such a claim it is an ordinary coin. A burn claim (section 10) is the opposite: it
   **is** a spend of the owner coin, in a transaction whose ring is chosen so that everyone
   sees which coin is spent. On a ledger with a first burn block every claim is of this kind
   once claim records have stopped (720 blocks after that block), and rules 1 and 2 do not
   hold for it: the transaction shows the
   coin's key image, and its ring is fifteen fixed outputs and the owner coin. Nothing after
   the claim (move, list, cancel, reserve, buy, burn record) spends or names a coin.

What becomes public: owner, seller and buyer addresses (as with XMR20 NFTs); sale prices;
with proof 1, the holder's address at the owner transaction and the owner coin's amount.

What a burn claim makes public, for good:

- which transaction spent the owner coin. The ring holds the owner output and fifteen
  outputs nobody can spend, so the spend hides behind nothing: the coin's key image, the
  block and the transaction are tied to the Mordinal for everyone;
- the address that receives the Mordinal, written in the transaction as plain text;
- the other inputs of that transaction, when the owner coin was too small to pay the fee,
  stay behind ordinary rings; the change output is a coin of whoever made the burn, tied to
  the receiving address by sitting in the same transaction;
- the amount of the owner coin stays hidden (a claim record with proof 1 shows it; a burn
  does not), and so does the holder's own address at the owner transaction.

A holder who wants no link between the receiving address and the wallet that held the coin
names a receiving address of another wallet in the text. The link between the old Mordinal
and the receiving address is the purpose of the claim and cannot be hidden.

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
| Protocol fee | 5% of every sale, Mordinals and minted NFTs | `RULES.feeBps` | decided |
| Mint fee | none | section 9 | decided |
| Largest mint record | 1,000 bytes (824 of name and content) | `MAX_RECORD` | decided |
| Who may mint | anyone, or only the addresses the ledger's setup lists; into a collection only its creator | section 9 | decided |
| First mint block | not set | ledger setup | open |
| Marketplace fee cap | 5% on top | `RULES.marketFeeCapBps` | decided |
| Lowest price | 0.001 XMR | `RULES.minPrice` | decided |
| Longest listing | 21,600 blocks after its record | `RULES.maxListing` | decided |
| Reservation length | at most 30 blocks | `RULES.maxReserve` | decided |
| Time to record a paid purchase | 10 blocks after the pay-by block | `RULES.settle` | draft |
| Entries per buy | 2 or 3, one per payee, from 1 to 3 transactions | `RULES.maxPayments` | decided |
| Claim deadline | none | — | decided |
| Old-style transfers after the start block | not honoured, except the burning transfer of section 10 on a ledger that has it | owner list | decided |
| First burn block | not set | ledger setup | draft |
| First block of claim records counting again | 3,814,262 on mainnet | ledger setup | decided |
| First block of offers | not set | ledger setup | draft |
| Longest offer | 5,040 blocks after its record (about 7 days) | `RULES.maxOffer` | draft |
| Pieces in one offer | 1 to 100 | `RULES.maxOfferCount` | draft |
| Claim records after the first burn block | 720 more blocks (about a day) | `RECORDS_OVERLAP` | draft |
| Burn address | section 10 | `rules/lib/burn.mjs` | draft |
| Dead outputs (mainnet) | 70499731–70499744 and 70499746, fixed | `MAINNET_DEAD` | draft |
| Payment-proof claim (proof 1) | kept; wallets warn what it shows | section 3 | decided |
| Buy record size | 296 or 425 bytes | record format | decided |
| Domain, fee address, start block | test values only | ledger setup | open |

## 8. How records travel

A record counts only when it is in a Monero block after the start block (the start block itself is read for its
hash only).

```
tx_extra = 01 <transaction public key 32>  [02 09 01 <payment id 8>]
           then per chunk: 02 <length> 7f <chunk>
```

- The record is cut into chunks of 254 bytes; only the last may be shorter and none is
  empty. A transaction carries a record only if its whole `tx_extra` parses exactly this
  way, in this order (the public key first, then the payment id if there is one, then all chunks with nothing after
  them), is at most 1,060 bytes, and the joined chunks start with `"MD1" 0xfe` and are at
  most 1,000 bytes. Anything else is not a record and is skipped.
- One transaction carries one record. Who made the transaction and what it pays do not
  matter: a record stands on its own signature or payments, so anyone can carry it. A
  relay carries records for wallets that cannot build such a transaction themselves; it
  cannot change a record.
- Records are applied in chain order: by block, then by the transaction's position in the
  block. A record that fails a check changes nothing, wherever it is.
- A buy record names payments that must be in a block and not after the buy record's block
  (section 5). A relay holds a buy record until its payments are in a block.
- When blocks are replaced, records in the replaced blocks are undone and the records of
  the new blocks applied; the result depends only on the chain.

## 9. New NFTs: collections, mints, burns (new in draft 4)

From the ledger's first mint block on, NFTs can be made. An NFT is named by 32 bytes: a
Mordinal by its registration transaction, a minted NFT by the id of its mint record.
`move`, `list`, `cancel`, `reserve` and `buy` take those 32 bytes in the `reg32` field and
work the same for both; the 5% protocol fee applies to every sale. Before the first mint
block, or on a ledger that names none, records 7, 8 and 9 are refused.

**Who may mint.** A ledger's setup may list its minters. Then only those addresses make
collections and mint; without a list anyone does. A setup with a list may also name an
**opening block** after the first mint block: from that block on anyone makes collections
and mints, as on a ledger without a list. Like the first mint block, the list and the
opening block are part of the setup that every reader of one ledger shares; from the first
mint block on a checkpoint names the first mint block and the list, and from the opening
block on also the opening block.
Moving, selling and burning are not limited by the list: they belong to the owner.

**Collection (op 7).** A minter can create one. Its id is the record's id, its creator is the
signer, `max` is its number of editions (1 to 10,000). `name` is 1 to 64 printable ASCII
characters with no space at either end and no double quote (`"`), so a name cannot close
the quotes a signed text puts around it. Two collections may have the same name.

**Mint (op 8).** Makes one NFT, signed by `creator`.
- `collection32` names a collection, and then `creator` must be that collection's creator,
  `edition` is 1 to `max` and not minted before. Or `collection32` is 32 zero bytes: the
  NFT belongs to no collection, `edition` is 0, and any minter can be the creator.
- The first owner is `to` when flags bit 0 is set, otherwise the creator. `to` is written
  only when it is another address.
- `content` is the inscribed bytes, at least 1. `type` (1 to 255) says what they are:
  1 PNG, 2 JPEG, 3 WebP, 4 GIF, 5 plain text (UTF-8), 6 JSON, 7 MP4, 8 text art; other
  values are kept and not shown. The rules do not look inside the content.
- `origin` (flags bit 1) is a statement by the creator of where the NFT comes from: a kind
  (1 = a Bitcoin inscription) and 1 to 64 bytes naming it. The rules do not check it.
  For kind 1 the 36 bytes are the inscription id `<txid>i<index>`: the 32 bytes of the txid as
  written in the id, then the index as a 4-byte little-endian number (`<txid>i0` is the txid
  followed by `00000000`). An origin takes 2 bytes plus its length (38 for kind 1).
- **The whole record is at most 1,000 bytes**, the room one relayed transaction has
  (section 8). That leaves 824 bytes for name and content, or 759 when `to` is written.
- There is no mint fee in the rules. A relay may charge for carrying a collection or a mint record; that is the
  relay's own price for its Monero network fee and against junk, not a rule. A record published any other way
  counts the same.

**Burn (op 9).** The owner ends an NFT, minted or a claimed Mordinal. `seq` is its counter
as in `move`; it must not be listed. Afterwards it has no owner and no record can touch it.
A burned edition is not free again.

Signed texts:

```
XMR721 collection: create "<name>" with <max> editions, minted only by <creator>; code <code>
XMR721 mint: edition <n> of "<collection name>" [named "<name>"]; <size> bytes of type <type>,
  SHA-256 <hash of the content>[; from <kind>:<ref hex>]; first owner <address>; code <code>
XMR721 mint: one NFT in no collection [named …]; …
XMR721 burn: destroy <NFT> for good; burn <seq>; code <code>
```

In the texts of the other records a minted NFT is written `"<collection name>" #<edition>
(NFT <code of its id>)`, or `NFT <code of its id>` when it has no collection, where a
Mordinal is written `Mordinal #<number>`. A reservation of a minted NFT ends `; NFT to
<buyer>; code <code>` where a Mordinal's ends `; Mordinal to <buyer>; code <code>`. An NFT's
own name follows the same rule as a collection's.

No record here spends or names a coin. A mint, like every record, rides in an ordinary
transaction that anyone can pay for.

Not in this draft: mints larger than one relayed transaction, mints that anyone can buy
from a creator, and bringing earlier collections (GENESIS) under these rules.

## 10. Claiming by burning (a ledger setting; the mainnet ledger uses it from block 3,808,200)

A ledger's setup may name a **first burn block**. Like the first mint block it is fixed for
the ledger and shared by every reader of it; a checkpoint names it from that block on.
From that block on:

1. **A Mordinal is claimed by burning it**: by a transfer in the original 2023 Mordinals
   format that moves it to an address nobody can spend from and names, in its text, the
   address that owns it from then on. Such a transaction is called a burn claim. It is not
   an MD1 record and needs no signature of its own: only the holder of the owner coin can
   spend it. A burning transfer in a block **before** the first burn block claims nothing,
   and its coin is spent. Claiming by burning is a paid service: the claimer pays the burn's
   own fee once more, to the Mordinal's fee address ("The fee" below); until then the burned
   Mordinal waits for it.
2. **Claim records stop 720 blocks later.** A claim record (op 1, either proof) still counts
   in the 720 blocks from the first burn block on (about one day; one fixed number, not a
   setting) and is refused in every block after them. In those 720 blocks both ways count
   and the first claim of a Mordinal that completes wins. The overlap is for a holder whose burn got
   into a block just before the first burn block, by sending early or because blocks were
   replaced: the burn claimed nothing, but a claim record signed with the coin's one-time
   key (proof 0) needs the keys and not the coin, and still claims the Mordinal. After the
   overlap there is no such way. Claims accepted earlier stay as they are: those Mordinals
   are claimed, their owner coins were not burned, and they cannot be claimed again.

Every entry of the owner list has to state the global index of its owner output; a ledger
with a first burn block does not open over a list that lacks one.

### The burn claim

A transaction in a block at or after the first burn block is a burn claim when all of this
holds. The checks are made in this order, and the first that fails is the reason a reader
writes down.

**(a) The text.** `tx_extra` is at most 1,060 bytes (the limit of section 8) and holds a
transfer field of the original format, tag `0x11`: a length and that many bytes of text.

```
tx_extra = fields, in any order, each whole, nothing left over:
   01 <public key 32>            the first one is the transaction public key
   02 <length> <bytes>           a nonce (payment id), length at most 255
   04 <count> <count × key 32>   additional public keys
   11 <length> <text>            the transfer; exactly one
lengths and counts are varints written the shortest way
```

This is narrower than the original parser on purpose. Whatever passes here the original
parser reads to the end and finds the same `0x11` field in, with no registration (`0x10`)
before it; a `tx_extra` with any other field, with padding, with two transfer fields, with
a registration or of more than 1,060 bytes is not a burn claim, whatever the original rules
make of it. A
transaction whose `tx_extra` does not read this way is not looked at; one that does is
judged and, when refused, kept in a reader's journal with the reason.

The text must be exactly

```
xmr721 claim to <address>
```

in ASCII: these sixteen characters, then one main address or subaddress of the ledger's
network, with nothing before or between. After the address the text ends, or has **one**
line end: a line feed (`0x0a`), or a carriage return and a line feed (`0x0d 0x0a`). Wallets
read the text from a file, and a file often ends that way (of 100 transfers of 2023
that were looked at, 20 carry a text and 13 of those end in a line break). Anything else after the address (a space, a second line end, a lone
carriage return) is refused. An integrated address is refused, and so is an address with a
key no wallet could use (section 2). A line end is part of the text for the fee rule.

**(b) The fee.** The transaction's fee is at least what the original rules ask for a text of
that length: 4,000,000 piconero for each byte, rounded up to a multiple of 0.001 XMR (0.001
XMR for the 111 bytes of the text above). The original rules ignore a transfer that pays
less; it would claim here and move nothing there.

**(c) The ring.** The inputs are looked at in order. The first input the original rule
reads as a transfer decides, and no input after it is looked at, as in the original: that
is the first input whose ring has all members but one inside the dead range (from the
lowest to the highest dead output). That ring must be exactly the **fifteen dead outputs**
and one other output, sixteen members in all, of amount 0 (as every output since RingCT).
The other output must be the **owner output** of a Mordinal on the owner list, by its global
output index, and that Mordinal must not be claimed yet.

**(d) The burn.** Output 0 of the transaction pays the **burn address**: with `R` the first
transaction public key in `tx_extra` and `a`, `B` the burn address's view secret key and
spend key,

```
output 0's key = Hs(8·a·R ‖ varint 0)·G + B
```

and when output 0 carries a view tag, it is the one this gives, so that a view-only wallet
of the burn address finds the payment. In a transaction that carries additional public keys (one that also pays a subaddress, such
as a fee address, does), output 0 is also looked for with the additional key of output 0, as
a wallet looks for it: `R` is then entry 0 of the first list of additional keys (field `04`)
that comes before the transfer field (a wallet stops reading `tx_extra` at the transfer
field, which it does not know). A derivation is looked at further only when the view tag, if
output 0 has one, is the one it gives. wallet2 pays a main address with the transaction key
itself; some other wallet libraries give every output a key of its own. Nothing else is
tried: no other entry of the list, no second transaction public key. The amount is not
looked at.

Such a transaction is a **valid burn claim**. Its Mordinal is then burned and claimed by
nobody until the fee for it is paid ("The fee" below). Once it is, the Mordinal belongs to
`<address>`, exactly as after a claim record to that address: claimed, counter 0, not
listed. Its history says it was claimed by burning and names the transaction.

A Mordinal that waits for its fee has no owner: it cannot be moved or listed. A second
burning transfer of it is refused ("This Mordinal was burned already; that burn waits for
its fee."): the first valid burn holds the Mordinal, as it did before the fee. Only a break
of the dead key (below) could make such a second transfer at all.

A transaction is a record carrier (section 8) or a burn claim, never both: a record's
`tx_extra` has no `0x11` field. Burn claims and records are applied in one order, by block
and then by the transaction's position in the block. The first claim of a Mordinal that
completes wins (a burn claim completes once its fee is paid). When blocks are replaced, burn
claims in them are undone like records.

### The fee

Claiming by burning is a paid service. The claimer pays **twice the burn's real cost**: the
burn transaction's own fee (`txnFee`: the network fee and the record cost of the original
rules; 0.00103 XMR for an ordinary burn) goes to the network, and an equal amount goes to the
project, paid to **the Mordinal's fee address**.

**The fee wallet** is the project's. Its secret view key is public by design, so that every
reader finds every fee payment:

```
main address     47BebHskardKh24pHr92oZ8wv9JLcyjmJQcUKTpzK4gshhHkffYBqnJ7CUFNRjbJ77iMx3bTgESDjXmBMJZeTKbhCoTxnfE
secret view key  8ecb6081cebfdc165fc9201fc5b9df7c86dad5e546b811a1783df0a312626f04      (public)
```

On mainnet it is fixed, like the dead outputs. Its keys are the same on every network; only
the written address differs. A ledger on another network or on the offline test chain may
name a wallet of its own; checkpoints from the first burn block on name the fee wallet.

**The fee address of Mordinal `n`** is the fee wallet's standard subaddress at account 1,
index `n + 1`, as every Monero wallet derives it:

```
m = Hs("SubAddr\0" ‖ a ‖ u32le(1) ‖ u32le(n + 1))  a = the secret view key above
D = B + m·G                                        B = the fee wallet's spend key; D: the subaddress's spend key
C = a·D                                            the subaddress's view key
```

Index 0 of account 1 is never a fee address: a wallet sends the change of a payment it makes
from account 1 there, and that change must not count as anyone's fee.

For example Mordinal #0 (index 1):
`8BURJxtSwnB4Qo8pPCUC3SfqWH8PpAzof513UMfKx3fjH6tbD3TEDfG8Ujv3LCvcQxHRuBbdqWs4MCv9rJ9zJTta9JMPPrV`,
#42,894 (index 42,895):
`889dJaWZqqBQYFb1D3AMgpDoRw7qG68MHQMe1a9VHW9HLUmhm4pzAor8UvVCoyuVAY3gTWrMMaFgZXnujr2i9FuzQ8XsTMx`
(more in `rules/tests/fixtures-burn.json`, as monero-wallet-rpc lists them).

**A fee payment** for Mordinal `n` is an output, in a transaction in a block at or after the
first burn block, that pays the fee address of `n`, found with the public view key the way
wallet2 finds its outputs:

1. The keys are read from `tx_extra` as wallet2 reads them: every transaction public key
   (field `01`), in order, and the first list of additional public keys (`04`). The reading
   goes past nonces (`02`), merge-mining tags (`03`, one string holding a varint and a
   32-byte hash and nothing else) and `0xde` fields, and ends, keeping what was read, at
   padding, at any other field (the transfer field `0x11` is one), at a field cut short or at
   a length not written the shortest way. A transaction without a transaction public key is
   passed over, as wallet2 passes it over. So is the block reward transaction, and a
   transaction that is not a current RingCT transaction (version 2, type 4 to 6, with an
   amount and a commitment for each output).
2. For output `i` the derivations are tried in wallet2's order: `8·a·R` with the first
   transaction public key, then with entry `i` of the additional keys, then with each further
   transaction public key; the first that finds the output is the one its amount is read with,
   which is also the key the fee wallet spends it with. An additional key is used only when it
   and every entry before it in the list are points of the curve: wallet2 drops an entry it
   cannot read from the list it scans with, so it would find an output there through another
   entry's key and could not spend it. A transaction public key that is not a point is passed
   over (wallet2 then scans with a derivation of its own making; no wallet writes such a
   key). A derivation is looked at further only when the output's view tag, if it has one, is
   the one the derivation gives.
3. `P − Hs(derivation ‖ varint i)·G`, with `P` the output's key, has to be the spend key `D`
   of the fee address of a Mordinal on the owner list.
4. The amount is the 8 bytes of `ecdhInfo` XOR `keccak("amount" ‖ Hs(derivation ‖ varint i))`.
   It counts only when `Hs("commitment_mask" ‖ Hs(derivation ‖ varint i))·G + amount·H` is the
   output's commitment: an amount written into `ecdhInfo` that the commitment does not hold is
   refused, as wallet2 refuses to spend such an output. An output of a transaction with a lock
   time does not count either.
5. Two outputs with the same one-time key `P` are one coin for a wallet: it keeps one of them,
   the larger. So a one-time key counts once, with the largest amount seen with it; a later
   output with the same key adds only what it holds above that. (The view key is public:
   anyone can write an output with a copied key and any amount.) This differs from wallet2 in
   one case: wallet2 takes a later, larger output with a known key only while it has not spent
   the earlier one, and this rule, which cannot see spending, always takes it. Whoever writes
   that later output pays its whole amount into it, so the credit it gives is never more than
   what its writer paid.

Fee payments are facts kept from the first burn block on, whatever the state of their
Mordinal. A payment for a Mordinal with no valid burn yet, or one already claimed, gives
nothing on its own; a later valid burn of that Mordinal uses the payments made before it. A
fee paid in a block before the first burn block is not counted.

**A burn claim completes** when the fee payments for its Mordinal, counted from the first burn
block up to and including the completing place, add up to at least the burn transaction's
`txnFee`. Everything is applied in one order: by block, by the transaction's place in the
block, and within a transaction first the record or the burn it carries, then its fee
payments. A burn therefore completes at the first place where both the valid burn and enough
fee are on the chain: at the burn itself when the fee was paid before it or is paid by the
burn transaction's own outputs, otherwise at the fee payment that reaches the amount. That
place is the claim's place in the ledger and its block in the Mordinal's history.

**A claim record while a burn waits for its fee.** In the 720 blocks in which claim records
still count, a claim record of a Mordinal whose burn waits is valid: the Mordinal is not
claimed. The first claim that completes wins. A record that comes first claims the Mordinal;
the waiting burn is then lost, and a fee paid for it afterwards gives nothing. A burn whose
fee is paid first claims the Mordinal, and a later claim record is refused as for any claimed
Mordinal. Only someone with the owner coin's keys can make either.

When blocks are replaced, fee payments in them are undone like records: a burn whose last
payment was taken away waits again, and claims at that payment's new place once it is in a
block again.

**For the fee wallet's operator.** Its view key is public, so every output it receives is
public, its own change included. Fees are moved out by sweeping them to another wallet, so
that the fee wallet makes no change; a payment made from account 1 sends its change to index
0, which is no fee address, and from another account to that account's index 0. The wallet
sees the fees only with a subaddress lookahead of at least 50,000 addresses in account 1
(reader/README.md).

### Dead outputs

On mainnet the dead outputs are the global output indexes **70499731 to 70499744 and
70499746**: the fifteen the 2023 wallet put into every transfer ring. All fifteen carry the
**same key**, `deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead000f`, the
`dead_key` constant of the original source: a pattern of bytes written into the outputs,
not a key made from a secret. The bytes do decode to a point of the main group, so a secret
key for it exists as a number; finding it is the discrete logarithm problem for a point
nobody chose.

The original rule counts every index from 70499731 to 70499746 as dead. **70499745 is left
out here**: it is the ordinary sixteenth output of the transaction that made the fifteen
(its change), with an ordinary key that whoever made that transaction may hold. Whoever
holds it could sign a ring of "dead" outputs and any Mordinal's owner output without owning
that Mordinal. A ring with 70499745 in it claims nothing here (the original rules still
read it as a transfer).

On mainnet this list is fixed: a mainnet ledger with other dead outputs is refused. A
ledger on another network names its own fifteen in its setup, and so does one on the
offline test chain (a reader with a list of its own reads only from a node of that chain);
they are then part of what a checkpoint states.

### The burn address

Nobody can spend from it, and everybody can see what it received.

```
spend key B    = hash_to_ec(keccak256("XMR721 Mordinal burn address v1: spend key"))
                 f78d3bb5ff9d953815e908b17aa7ab0a1f4351cdaf919f390d606d1786234b80
view secret a  = keccak256("XMR721 Mordinal burn address v1: view key") mod l      (public)
                 c91c974a0b5c6a9604aec311ab39442cd5aa724c0b9ff98c45935a1cbe985902
view key a·G   = ccd30ddaf276258c2897d5a0f3f392814691d7465dd0019065ea194d0985bfb0
mainnet        4B1DGeU3FMvAP6pv3JPYkJ2hCSZPzj7VGAYUk4LT73BGNYXHuc1X6kcQSiPn9ydpMFNd8t4H6J1pcR9qs7Tb6DLSLs5y93o
stagenet       5BDFMVNzty2AP6pv3JPYkJ2hCSZPzj7VGAYUk4LT73BGNYXHuc1X6kcQSiPn9ydpMFNd8t4H6J1pcR9qs7Tb6DLSLvphcAv
```

`hash_to_ec` is Monero's function of that name, the one behind key images: Keccak-256 of its
input, mapped to a curve point, times 8. `B` came out of a hash, so no secret key is known
for it. The keys are the same on every network; only the written address differs.

### What it rests on, and what it does not do

- Only the holder of the owner coin can make a ring that spends it, **as long as nobody
  finds a secret key for the dead key**. The fifteen dead outputs share one key and so one
  key image: whoever had its secret key could spend one of them, once, in a ring with any
  unclaimed Mordinal's owner output, and claim that Mordinal. A break would therefore allow
  **one theft in total**, not fifteen. This is the trust the original rules always asked,
  minus 70499745.
- The original rules, run by anyone who still keeps the 2023 index, read a burn claim as a
  transfer to output 0: for them the Mordinal now sits on an output nobody can spend, with
  the claim text as its latest text. This is what "burned" means; the rules here do not
  check any original index.
- A Mordinal whose owner coin was already spent by an ordinary transaction cannot be claimed
  by burning: the coin cannot be spent again. Its holder can claim by record until claim
  records stop; after that only if the coin was spent from the first block of claims by a
  spent coin on, on a ledger that has it (section 11).
- A burn that is refused (another text, a ring this rule does not take, a fee too low, a
  block before the first burn block) has spent the coin all the same and cannot be made
  again. Until claim records stop, the holder can still claim by record with the one-time
  key.
- The owner list is the one of the start block. An original-format transfer after the start
  block that is not a burn claim moves nothing here; a burn claim must spend the owner
  output the list names.
- The node that relays a burn claim may refuse it when asked for its ring sanity check (the
  default of `send_raw_transaction`); that is advice to wallets, not a rule of the network.
- **The fee is public.** With the fee wallet's view key anyone sees every fee payment: its
  amount, its transaction, and the Mordinal it is for (the subaddress index is the number
  plus one). A fee payment links the paying transaction to that Mordinal's claim. It is paid
  from a wallet that holds no inscribed coins, never one restored from the seed of the 2023
  wallet: a payment may spend any coin of its wallet.
- **A fee is not refunded.** A fee paid without a valid burn (also for a burn that is
  refused), a payment to the fee wallet's main address or to another Mordinal's fee address,
  an amount beyond what is due, and a fee for a burn that a claim record overtook stay with
  the project. So does a payment wallet2 finds and this rule does not: one it would find
  through a transaction public key that is not a point, or one in a transaction that is not a
  current RingCT transaction.
- A fee is paid after the burn is in a block: the Mordinal's page then shows it waiting, with
  the exact amount still missing. Someone who pays for another holder's burn waits until claim
  records stop: until then the holder can still claim by record, and the burn would be lost.

Code: `rules/lib/burn.mjs` and `rules/lib/burn-fee.mjs`; the checks in order: `burnClaim` in
`rules/lib/ledger.mjs`, the fee in `applyBurnFees` there.
Tests: `rules/tests/burn.test.mjs` (with one real pair of mainnet transactions in
`rules/tests/fixtures-burn.json`; that burn paid no fee and waits for it),
`rules/tests/burn-fee.test.mjs`, `reader/tests/burn.test.mjs`, `reader/tests/lab-burn.test.mjs`.

Reader and relay: `reader/`.

## 11. Claiming by a spent coin (a ledger setting; the mainnet ledger uses it from block 3,813,165)

A ledger that claims by burning may also name a **first block of claims by a spent coin**, at
or after its first burn block. Like the first burn block it is fixed for the ledger and
shared by every reader of it; a checkpoint names it from that block on. From that block on a
claim record with **proof 2** claims a Mordinal whose owner coin was spent, from that block
on, by an ordinary transaction: the way for a holder whose wallet builds no burn. Proof 2
counts whether claim records still count or not. Like a burn claim it is a paid service: it
completes once the Mordinal's fee address has received the fee below.

**Proof 2 — payment proof, signed key image and message.** Three parts:

- the payment proof of proof 1: a wallet2 `InProofV2` for the owner transaction and the
  holder's address, made with an empty message, covering exactly one transaction key;
- the owner coin's **key image** `I` and a signature that `I` belongs to the coin's one-time
  key `P`: what a wallet's key image export holds for that coin (wallet2
  `export_key_images`; in Feather, Tools → Offline transaction signing, after importing an
  outputs file that lists the coin). It needs the coin's secret key `x`, so only a wallet
  that holds the spend key can make it; a view-only wallet cannot;
- a "sign message" signature by the holder's address (spend key) over the claim text, which
  names the transaction that spent the coin:

```
Mordinals claim: Mordinal #N (inscription <reg>), held by output 0 of <ownerTx> and spent in <spendTx>, now belongs to <to>; code <code>
```

The signed key image is wallet2's ring signature over a ring of one, with `I` itself as the
hash it signs:

```
I = x·Hp(P)        Hp = hash_to_ec (section 10)
k random     c = Hs(I ‖ k·G ‖ k·Hp(P))     r = k − c·x
accepted when c and r lie in 1 … ℓ−1, I is a usable point, and Hs(I ‖ r·G + c·P ‖ r·Hp(P) + c·I) = c
```

The checks, in this order, after those of every claim (the owner transaction is on the
owner list, the Mordinal is not claimed) and the payment proof of proof 1:

1. Nothing waits for the Mordinal: no burn claim waits for its fee, and no other claim by a
   spent coin does.
2. The signed key image is valid for the owner coin's `P`.
3. The reader has looked up `spendTx` on the node, and it is in a block **before** the block
   of the record. A spend in the same block as the record, in a later one or only in the
   pool does not count.
4. `spendTx` is in a block at or after the first block of claims by a spent coin. A coin spent
   before that block never claims this way: the claim is for someone who holds the Mordinal
   when this section starts.
5. One input of `spendTx` has the key image `I`. Monero accepts a key image once, so this is
   the one transaction that spent the owner coin.
6. `spendTx` did not move the Mordinal under the original rules. It is refused when the 2023
   indexer reads a transfer in its extra field (a transfer field, 0x11, and no registration
   field, 0x10, read field by field exactly as that indexer reads them: a field that does not
   read ends the reading, and a length that the end of the extra field cuts short is the
   value read so far; `originalTransfer` in `rules/lib/spend.mjs` lists the field types)
   **and** one of its inputs has a ring whose members all lie in the
   dead range (section 10, from the lowest to the highest dead output) but one, and that one
   is this Mordinal's owner output. That is a transfer or a burn of this Mordinal, and its
   holder no longer holds it (a burn is claimed by section 10). The transfer's fee and the
   place of that input are not looked at: such a transaction counts as having moved the
   Mordinal either way. Any other spend moves nothing under the original rules: an ordinary
   transaction, a registration, or a transfer of another Mordinal that spent this coin beside
   it.
7. The message signature is by the holder's address (spend key).

A record that passes waits for its fee, like a burn claim (section 10): the Mordinal is not
claimed yet, and no other claim by a spent coin can claim it. While claim
records still count, a claim record of proof 0 or 1 still can, and the claim by a spent coin
is then passed over.

**The fee.** The network fee of the transaction that carries the claim record, as the chain
shows it (`txnFee`), and 0.0025 XMR on top (the fixed part is part of the rules: a reader
with another amount reads another ledger). So the fee follows what the network asks at the
time: about 0.00004 XMR at the base rate, more when blocks are full. It is paid to the
Mordinal's fee address of section 10. A record whose carrying transaction shows no fee is
refused. Every payment to that address counts, also one made
before the record. The claim completes in the block where the payments reach the fee, or in
its own block when they had already. The fee rules of section 10 apply: public, not refunded.

A claim that waits cannot be changed or withdrawn, and once its fee is paid the Mordinal goes
to the address in it: check that address before signing.

Before the first block of such claims a record with proof 2 is no known record (an unknown
proof kind), as it was before this section existed.

The record of a claim by a spent coin is 489 bytes. The relay holds it until `spendTx` is in a
block below the reader's newest one, so the record cannot reach a block before it, and
refuses it when the node does not know `spendTx`.

**What it rests on, and what it shows.**

- The claim rests on the **message signature**: only the spend key of the address that
  received the coin (as the payment proof shows) can make it, and it names `to`, `spendTx`
  and the code. The payment proof needs only the view key, and the signed key image is not
  bound to the claim (it shows that `I` is the coin's key image, so that `spendTx` is the
  transaction that spent it); someone who holds a view-only copy of the wallet, or a key
  images file it exported, can supply those two parts but not the signature.
- Only a coin spent from the first block of such claims on counts. Someone who spent the
  coin earlier, whatever became of the Mordinal since, has no claim here; the holder of an
  unspent owner coin spends it in an ordinary transaction, which moves nothing under the
  original rules, and claims.
- **It is public.** Beyond what proof 1 shows (the holder's address and the amount of the
  owner coin), the record shows which transaction spent the coin. That links `spendTx`, its
  other inputs and its change to the holder's address, and it marks the owner output as
  spent there, so rings that use it as a decoy elsewhere lose it as a candidate.
- A burn that was refused spent the coin in an original-format transfer of this Mordinal: the
  Mordinal moved to the burn address under the original rules, and this section gives it no
  way either (`docs/OPEN-POINTS.md`).

Code: `rules/lib/spend.mjs`; the checks in order: `spentCoin` in `rules/lib/ledger.mjs`, the
waiting and the fee as for burn claims. Tests: `rules/tests/spend.test.mjs` (with three key
images that Feather exported, in `rules/tests/fixtures-spend.json`), `reader/tests/spend.test.mjs`.

## 12. Claim records again (a ledger setting; the mainnet ledger uses it from block 3,814,262)

A ledger that claims by burning may name a **first block of claim records counting
again**. It is fixed for the ledger and shared by every reader of it, and a checkpoint
names it from that block on. It lies at or after the block where claim records stopped
(the first burn block plus 720).

From that block on a claim record of proof 0 or proof 1 counts as section 3 says, as it
did before the first burn block. In the blocks between the end of the 720 blocks and this
block such a record is refused. Its entry in the log stays refused; the same record carried
again in a transaction from this block on counts like any other.

Nothing else changes:

- A Mordinal is claimed once. The first claim that completes wins, whichever way it was
  made: by record, by burning (section 10) or by a spent coin (section 11).
- Burn claims and claims by a spent coin go on as before, with their fees. A claim record
  pays no fee to the project.
- A claim record needs the keys of the owner coin and not the coin: the coin is not spent
  and no key image is shown. A holder whose coin was spent in an ordinary transaction, or
  whose burn waits for its fee, can claim by record too. A burn that waits for its fee is
  lost when a record claims its Mordinal first, with whatever was paid towards that fee.
- A Mordinal claimed by record keeps its owner coin. Under the original 2023 rules that
  coin can still be moved; this ledger does not follow such a move (section 7), so the
  owner here stays the address the claim named until a signed record moves it.

Why a ledger takes this setting: a holder shows the Mordinal is theirs by signature, from
the wallet that holds it, and sells or sends it from then on without spending the coin.
The coin stays unspent for a later change of the rules that ties an NFT to its coin again.

A reader takes the setting in like a first block of claims by a spent coin: a state folder
that has not read the block yet, with the block at least 10 blocks above the newest block
of the folder and of the node.

## 13. Offers (a ledger setting)

A ledger may name a **first block of offers**. From that block on three more records
count. Before it, and on a ledger without the setting, they are unknown operations.

An offer is a signed, public promise to buy. Nobody holds the bidder's XMR. An owner
accepts with one signature, and the bidder then pays as in section 5.

1. **Offer.** Signed by the bidder's address, which also receives what is bought. Lowest
   price 0.001 XMR. The last block is at most 5,040 blocks (about 7 days) after the block
   of the offer. `count` is 1 to 100: how many pieces the bidder buys at this price; an
   offer for one NFT (kind 0) is for one piece. The
   fee address cannot make an offer. A marketplace fee is named as in a reservation. An
   offer is for one of:
   - kind 0, one NFT: `ref` is its 32 bytes (a Mordinal's registration, or a mint's id);
   - kind 1, a collection made on this ledger (section 9): `ref` is its id;
   - kind 2, a set of Mordinals: `ref` is the root of the set's list.
2. **Accept.** Signed by the current owner of a piece (right `seq`) that the offer is
   for, that is not listed, and whose owner is neither the bidder nor the fee address.
   The offer is open (not withdrawn, not closed, not complete, not ended), has a piece
   left that no running accept holds, and ends no sooner than 40 blocks after the block
   of the accept. For kind 2 the accept carries the path that shows its Mordinal is on
   the list; for kinds 0 and 1 it carries none.
3. **What an accept does.** It is a listing at the offer's price and a reservation for
   the bidder, in one record: pay-by block = the block of the accept + 30, held until
   pay-by + 10. Amounts, the tail (from the accept's code), the protocol fee, the payment
   proof and the buy record are those of section 5; the buy record names the accept as
   its lot. Nobody else can reserve this sale, and the seller cannot cancel it.
   The payment is in a block no later than the pay-by block, and the buy record in a
   block no later than pay-by + 10: the ten blocks are for the record alone. A payment
   made after the pay-by block does not count. Wallets and pages must refuse to pay late.
4. **Paid.** The piece moves to the bidder and the offer has one piece fewer left. With
   none left it is complete.
5. **Not paid.** In the block after pay-by + 10 the piece is free again by itself: no
   record is needed, and its `seq` goes up by one as after a cancelled listing. The offer
   **closes for good**. Accepts of it that are still running can still be paid.
6. **Withdraw.** Signed by the bidder. The offer takes no new accept; running ones can
   still be paid.

The same lines rule as in section 5 applies: an accept is refused when one of its payee
lines equals a line another open sale is waiting for.

### The list of a set

```
leaf = SHA-256(0x00 ‖ registration)
node = SHA-256(0x01 ‖ the smaller child ‖ the larger child)      compared as bytes
```

The leaves are the registrations of the set, each once, in ascending order. A level with
an odd number of nodes hands its last node up unchanged. The root of a set of one is its
leaf. A path is the sibling at each level from the leaf up, at most 20 entries; a level
without a sibling adds nothing. The rules check the path and nothing else about a set:
which Mordinals a named collection holds is published by whoever shows the offer, and
anyone can compute the root from that list.

### What it rests on

An accepted offer is a reservation, not money: the bidder may not pay. The cost of that
is one closed offer and about 80 minutes of one seller's piece. An offer does not lock
the bidder's XMR, and the bidder's address is public from the offer on.

A relay may charge for carrying an offer. That is the relay's price, not a rule.
