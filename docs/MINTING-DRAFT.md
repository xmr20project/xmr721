# XMR721: creating, moving and burning NFTs (design draft)

11 November 2026. A proposal, not part of the rules yet. Nothing here is implemented.
`RULES.md` (draft 3) covers Mordinals that already exist; this page proposes how new NFTs
are made under the same rules, what fits in one Monero transaction, and how an NFT is
burned. Values marked **open** are choices still to make.

## 1. What stays the same

- An NFT is owned by a Monero address. Every change is a signed record carried in an
  ordinary Monero transaction and applied in chain order.
- A record is `"MD1" 0xfe op body [signature]`, signed with "sign message" by the spend
  key of the address that acts.
- An NFT is named by 32 bytes. For a Mordinal that is its registration transaction; for a
  minted NFT it is the id of its mint record. The existing records `move`, `list`,
  `cancel`, `reserve` and `buy` take those 32 bytes, so sending and selling a minted NFT
  needs no new record.
- No rule ever asks anyone to spend a particular coin or show which coin was spent. The
  transaction that carries a record is a normal one with normal decoys, and it can be paid
  by anyone (a relay, or the signer's own wallet). That is what keeps "black marbles" out:
  there is no known-spent coin to end up in other people's rings.

## 2. New records

```
op 7 collection  creator  max(u32)  flags(u8)  name(len u8, 1–64 bytes)            variant c32 r32
op 8 mint        collection32  edition(u32)  creator  flags(u8)  [to]
                 name(len u8, 0–64 bytes)  type(u8)  content(len u24, bytes)       variant c32 r32
op 9 burn        nft32  seq(u32)  owner                                            variant c32 r32
```

**Collection.** Creates a collection. Its id is the record id; `creator` is its authority;
`max` is the largest edition number (1 to 10,000). Only the authority can mint into it.
`flags` bit 0: closed for good once every edition is minted (always true in this draft;
other bits must be 0).

**Mint.** Creates one NFT.
- `collection32` is a collection id, or 32 zero bytes for an NFT that belongs to none
  (then `edition` is 0).
- The signer is `creator`: the collection's authority, or anyone for an NFT without a
  collection.
- `edition` is 1 to `max` and not minted before.
- The first owner is `to` when `flags` bit 0 is set, otherwise `creator`.
- `content` is the inscribed bytes themselves. Nothing is linked from elsewhere: the whole
  NFT is in the record.
- `type` says what the bytes are: 1 PNG, 2 JPEG, 3 WebP, 4 GIF, 5 plain text (UTF-8),
  6 JSON, 7 MP4, 8 "text art" (a picture and a text drawn over it, the GENESIS look).
  Readers show only types they can show safely; an unknown type is kept and not shown.
- The NFT's id is the mint record's id. The same record cannot count twice.

**Burn.** The owner ends an NFT. It must not be listed or reserved; `seq` is its counter,
as in `move`. A burned NFT has no owner, cannot be moved or sold again, and stays in the
history. A burned edition number is not free again.

**Move, list, cancel, reserve, buy** are unchanged.

## 3. What fits in one transaction

Monero nodes pass along a transaction only when its extra data is at most 1,060 bytes.
With the record framing of RULES.md section 8, that leaves **1,000 bytes for a record**.

| Mint | Bytes around the content | Room for name + content |
|---|---|---|
| Owner is the creator | 177 | **823** |
| Owner is another address (`to`) | 242 | **758** |

(5 bytes of magic and op, 32 collection, 4 edition, 65 creator, 1 flags, 1 + name, 1 type,
3 content length, 65 signature.)

So a **standard mint** carries about 750 to 820 bytes of content: small pixel art, a small
palette picture such as the GENESIS pieces (which are 300 to 900 bytes each), or text. It
travels like any other transaction, through a relay or any wallet that can attach extra
data.

A **large mint** is one transaction too, but with content far above that. No node relays
it, so it has to be put into a block by the miner who finds the block: in practice, by
mining the block ourselves, as was done for the 598,000-byte video in block 3,799,494.
- It may sit in an ordinary transaction or in the mining reward transaction of that block.
- The record is carried whole in one extra field of tag `0xDE`, not in 254-byte pieces.
- The ceiling is set by Monero's block size rules: about **598,000 bytes** today for a
  whole block, at the price of most of that block's reward.
- A reader has to read the mining reward transaction of every block for this.

Both kinds are one record in one transaction. Nothing is ever split over several
transactions.

## 4. Privacy

- Minting, sending, selling and burning never spend a named coin. No coin of any kind is
  marked, so there is nothing that could become a black marble.
- A mining reward transaction has no inputs at all, so a large mint shows nothing either.
- What is public by design: the creator's address, each owner's address, and prices.
  Use an address kept for NFTs.
- If the signer pays for the carrying transaction from the same wallet, an observer may
  guess that the wallet and the address belong together. Sending through a relay avoids
  that. The rings of that transaction are normal either way.
- Buying has the limits RULES.md section 6 already states (the payment is tied to the
  buyer's address for good).

## 5. Fees

- The Monero network fee of the carrying transaction, paid by whoever sends it.
- Sales: 5% protocol fee, as for Mordinals (**open**: the current decision says "Mordinals
  only").
- Mint fee: **open**. Options: none; a fixed XMR amount per mint to the fee address,
  proven the way a purchase is; or a fee per collection.

## 6. Collections made before XMR721

GENESIS and the other XMR20 NFT collections are in an earlier format with rules of their
own. To trade them here they have to be adopted: one record or a setup list that fixes
each edition's owner at a block, the way the Mordinals owner list does. Not designed here.

## 7. Open choices

1. Mint fee (section 5), and whether the 5% sale fee applies to minted NFTs.
2. Who may mint without a collection: anyone (as drafted) or nobody.
3. Open mints, where anyone can mint an edition by paying the creator. Not in this draft.
4. Large mints: allow them (needs our own mined blocks and a reader that reads mining
   reward transactions), or keep to standard mints at first.
5. Content types to show, and whether text art (type 8) gets its own packed layout.
6. Numbers: Mordinals keep 0 to 42,893. New NFTs could be numbered on in chain order, or
   be known only by collection and edition.
7. A field that points at where an NFT came from (for Sweep and Burn: the burned Bitcoin
   inscription), so the link is part of the mint.
8. Burn: as drafted, or no burn record at all.

Everything here needs the same outside review as RULES.md before it is used.
