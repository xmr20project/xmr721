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

op 1 claim    reg32 ownerTx32 to proof(u8) [holder when proof = 1]
              proof 0: c32 r32
              proof 1: D32 pc32 pr32   variant(u8) c32 r32
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

On a ledger with a first burn block, claim records count only in the blocks before it; from
that block on a Mordinal is claimed as section 10 says. What follows describes the claim
record.

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

Never accepted as a claim record: OutProofs, spend proofs, reserve proofs, key images, any
spend of the owner coin. (The one spend that claims is the burning transfer of section 10,
on a ledger that has it.)

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
   sees which coin is spent. On a ledger with a first burn block every claim from that block
   on is of this kind, and rules 1 and 2 do not hold for it: the transaction shows the
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
| Burn address | section 10 | `rules/lib/burn.mjs` | draft |
| Dead outputs (mainnet) | 70499731–70499744 and 70499746 | `MAINNET_DEAD` | draft |
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

## 10. Claiming by burning (draft; a ledger setting no ledger uses yet)

A ledger's setup may name a **first burn block**. Like the first mint block it is fixed for
the ledger and shared by every reader of it; a checkpoint names it from that block on.
From that block on:

1. **Claim records no longer count.** A claim record (op 1, either proof) in a block at or
   after the first burn block is refused. Claims accepted in earlier blocks stay as they
   are: those Mordinals are claimed, their owner coins were not burned, and they cannot be
   claimed again.
2. **A Mordinal is claimed by burning it**: by a transfer in the original 2023 Mordinals
   format that moves it to an address nobody can spend from and names, in its text, the
   address that owns it from then on. Such a transaction is called a burn claim. It is not
   an MD1 record and needs no signature of its own: only the holder of the owner coin can
   spend it.

### The burn claim

A transaction in a block at or after the first burn block is a burn claim when all of this
holds. The checks are made in this order, and the first that fails is the reason a reader
writes down.

**(a) The text.** `tx_extra` holds a transfer field of the original format, tag `0x11`: a
length and that many bytes of text.

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
before it; a `tx_extra` with any other field, with padding, with two transfer fields or
with a registration is not a burn claim, whatever the original rules make of it. A
transaction whose `tx_extra` does not read this way is not looked at; one that does is
judged and, when refused, kept in a reader's journal with the reason.

The text must be exactly

```
xmr721 claim to <address>
```

in ASCII: these sixteen characters, then one main address or subaddress of the ledger's
network, and nothing before, between or after (no line end). An integrated address is
refused, and so is an address with a key no wallet could use (section 2).

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
of the burn address finds the payment. Additional public keys are **not** used for this
check: a wallet pays a main address with the transaction key itself, also in a transaction
that carries additional keys. The amount is not looked at.

Then the Mordinal belongs to `<address>`, exactly as after a claim record to that address:
claimed, counter 0, not listed. Its history says it was claimed by burning and names the
transaction.

A transaction is a record carrier (section 8) or a burn claim, never both: a record's
`tx_extra` has no `0x11` field. Burn claims and records are applied in one order, by block
and then by the transaction's position in the block. The first valid claim of a Mordinal
wins. When blocks are replaced, burn claims in them are undone like records.

### Dead outputs

On mainnet the dead outputs are the global output indexes **70499731 to 70499744 and
70499746**: the fifteen the 2023 wallet put into every transfer ring. Their keys are bytes
that begin `deadbeef…`, for which nobody has shown a secret key. The original rule counts
every index from 70499731 to 70499746 as dead. **70499745 is left out here**: its key is an
ordinary one that somebody may hold, and whoever holds it could sign a ring of "dead"
outputs and any Mordinal's owner output without owning that Mordinal. A ring with 70499745
in it claims nothing here (the original rules still read it as a transfer).

A ledger on another network, or a test chain, names its own fifteen in its setup; they are
then part of what a checkpoint states.

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

- Only the holder of the owner coin can make a ring that spends it, **as long as nobody can
  spend one of the fifteen dead outputs**. Somebody who could spend one could sign a ring of
  the fifteen and any unclaimed Mordinal's owner output, once per dead output, and claim that
  Mordinal. This is the same trust the original rules always asked, minus 70499745.
- The original rules, run by anyone who still keeps the 2023 index, read a burn claim as a
  transfer to output 0: for them the Mordinal now sits on an output nobody can spend, with
  the claim text as its latest text. This is what "burned" means; the rules here do not
  check any original index.
- A Mordinal whose owner coin was already spent by an ordinary transaction cannot be claimed
  by burning: the coin cannot be spent again. This draft has no other way for it
  (`docs/OPEN-POINTS.md`).
- The owner list is the one of the start block. An original-format transfer after the start
  block that is not a burn claim moves nothing here; a burn claim must spend the owner
  output the list names.
- The node that relays a burn claim may refuse it when asked for its ring sanity check (the
  default of `send_raw_transaction`); that is advice to wallets, not a rule of the network.

Code: `rules/lib/burn.mjs`; the checks in order: `burnClaim` in `rules/lib/ledger.mjs`.
Tests: `rules/tests/burn.test.mjs` (with one real pair of mainnet transactions in
`rules/tests/fixtures-burn.json`), `reader/tests/burn.test.mjs`.

Reader and relay: `reader/`.
