# Open XMR20 tokens

Status: in use on Monero mainnet from block 3,812,510 (the opening block). Experimental:
the rules have had no independent outside review. The opening block and the rules of
records already on the chain do not change. Section 11 lists what is still open, section 12
where the code and the test cases are.

Today an XMR20 token starts at a launchpad: the launchpad announces it
([FORMAT.md](FORMAT.md), [EARLIER.md](EARLIER.md)) and its supply reaches Monero through the
bridge. This document adds a second way that needs no launchpad, no bridge and no server:
anyone announces a token with one inscription, anyone mints it, and every reader works out
the balances from the Monero chain alone, the way BRC-20 works on Bitcoin.

It changes nothing for the tokens that exist. They stay tokens, with the same ids, the same
balances and the same records (section 2).

## 1. The two ledgers this uses

- **XMR721** ([RULES.md](../RULES.md)): the ledger of inscriptions. A token is announced
  there, by a deploy inscription.
- **The XMR20 token ledger** (the engine in `xmr20project/xmr20-wallets`): the ledger of
  balances. Tokens are held there as notes and moved by the records wallets already make
  (`XP1` transfer, `XW1` move signed by a Monero address, `XT1` trade, and the others).

Both ride in ordinary Monero transactions in the same carrier fields (RULES.md section 8),
and both are read in chain order. An open token needs one new text on the first ledger
(section 3) and one new record on the second (section 6).

## 2. Three kinds of token, one list

A reader lists every XMR20 token, of three kinds:

| Kind | Announced by | Named by | Supply on Monero comes from |
|---|---|---|---|
| `earlier` | a deploy in the first format, signed by the launchpad's deployer (EARLIER.md): the 80 tokens up to block 3,804,029 and those read on since | its Solana mint | bridge credits (`XC1`) |
| `launched` | a deploy inscription by a listed inscriber (FORMAT.md) | its Solana mint | bridge credits (`XC1`) |
| `open` | a deploy inscription by anyone (this document) | the id of its deploy inscription | the deploy itself and mint records (`XO1`) |

Rules that keep the three apart:

1. Everything in FORMAT.md and EARLIER.md stays as it is. A reader that follows this
   document lists the same `earlier` and `launched` tokens, with the same numbers, as one
   that does not.
2. The balances of `earlier` and `launched` tokens are the ones the token ledger holds
   today. No record is added, changed or removed for them.
3. A token is of one kind for good. The kind follows from its deploy and never changes.

`earlier` and `launched` tokens are **bridged**: a token on Monero stands for a token held
on Solana, and the bridge's issuer key signs every credit. An `open` token has no issuer:
its supply follows from the chain and nothing else.

## 3. The open deploy text

```json
{"p":"xmr20","op":"deploy","tick":"PEPE","name":"Pepe","max":"21000000","dec":"6","mode":"open","lim":"1000"}
{"p":"xmr20","op":"deploy","tick":"PEPE","max":"21000000","dec":"6","mode":"open","lim":"1000","pre":"1000000"}
{"p":"xmr20","op":"deploy","tick":"MINE","max":"1000000000","dec":"6","mode":"open","pre":"1000000000"}
```

| Field | | Meaning |
|---|---|---|
| `p` | required | `"xmr20"` |
| `op` | required | `"deploy"` |
| `tick` | required | the ticker, as in FORMAT.md: 1 to 32 characters, any script |
| `name` | optional | the token's name, as in FORMAT.md |
| `max` | required | the whole supply in whole tokens: digits with no leading zero, 1 to 18,446,744,073,709 |
| `dec` | required | `"6"` |
| `mode` | required | `"open"` |
| `col` | optional | the id of an XMR721 collection that belongs to the token |
| `lim` | see below | the most one mint record can mint, in whole tokens: 1 to `max` |
| `pre` | optional | the creator's share in whole tokens, 1 to `max`: credited to the creator when the token is deployed |

- `lim` is written when something is left to mint (`pre` is absent or below `max`) and is
  absent when `pre` equals `max`.
- `pre` is absent when the creator takes nothing. `"pre":"0"` is not a deploy text.
- There is no `mint` and no `pair`: an open token names no Solana mint.
- Every XMR20 token has 6 decimals, so `dec` is `"6"`. Amounts in records are whole numbers
  of the smallest unit (one token = 1,000,000 units) and fit 8 bytes; that is where the
  largest `max` comes from.
- The text is written one way only, as in FORMAT.md: the fields in the order of the table,
  no spaces, nothing else in the object, UTF-8, at most 600 bytes. The rules for `tick` and
  `name` (lengths, the characters that are refused) are those of FORMAT.md.

**Tickers are not unique and not reserved.** Any ticker can be deployed any number of
times, by anyone, also one that a bridged token carries. A token is known by its id
(section 5). Pages and wallets show the id, or the start of it, next to the ticker.

A reader that does not know this document reads these texts as "not a deploy" (FORMAT.md
refuses a field it does not know), so nothing changes for it.

## 4. Which inscriptions are open tokens

There is one **opening block** for open tokens, fixed for the ledger and the same for
every reader: 3,812,510 on mainnet. From that block on, going through the chain in order, an
inscription is an open deploy when all of this holds:

1. it is a mint record (op 8) that decodes exactly as RULES.md says, and its signature
   holds;
2. it is in no collection (`collection32` is zero, `edition` 0) and has `type` 6;
3. it is as plain as a mint record can be: `flags` is 0 (no first owner other than the
   creator, no origin) and the NFT has no name of its own (`name` is empty);
4. its `content` is exactly an open deploy text (section 3);
5. no record with the same id was an open deploy in an earlier place from the opening
   block on;
6. no earlier open token has an id that starts with the same 16 hex characters. A signed
   text shows those characters (section 7), and a creator can make two ids of their own
   that start alike in about an hour of computing, so the later of two such deploys is
   refused and no two tokens are ever named by the same words;
7. the transaction carries it the way RULES.md section 8 says, in that order: the public
   key first, then the payment id if there is one, then the chunks. The token ledger's own
   records are read in any order; a deploy is read the one way the XMR721 readers read it;
8. its asset has no supply on the token ledger yet (section 8).

Making a deploy whose id starts like somebody else's token takes about 2^64 tries, far
more than a deploy waiting for a block allows. A creator whose deploy is refused by rule 6
or rule 8 deploys again with another field.

Nothing else is asked: no list of inscribers, no fee beyond the Monero network fee, no
permission. The **creator** is the address that signed the record (`creator`).

Rule 3 keeps the record to one shape, so that every implementation reads the same bytes
the same way: an open deploy is these fields and nothing else.

```
"MD1" 0xfe  08  32 zero bytes  00 00 00 00  creator(kind, spend key, view key)  00  00  06
content length (u16)  content  variant  c  r
```

A deploy record carried in a block before the opening block makes an NFT and no token.
The same record carried again in a block from the opening block on is the token's deploy:
rule 5 counts from the opening block. The XMR721 ledger passes that second record over (its
id is on the ledger), so the token's inscription is the NFT of the first one; the id, the
text and the creator are the same. Only the creator can make a record with that id.

Whether a record is an open deploy depends on its bytes, the field that carries it, its
signature, its block and the open tokens before it. It does not depend on what the XMR721
ledger holds, so a reader of the token ledger needs no
state of the other ledger to follow open tokens.

The inscription stays an NFT like any other. Moving it or burning it changes nothing for
the token: an open token cannot be withdrawn, renamed or changed by anyone, its creator
included.

Each open deploy takes the next token number after the tokens before it in ledger order
(FORMAT.md, "Which inscriptions are tokens"). Numbers are for display; records never use
them.

## 5. Token id and asset id

- The **token id** of an open token is the id of its deploy record (32 bytes, RULES.md
  section 2), written as 64 hex characters.
- Its **asset id** in the token ledger is derived from the token id the way a bridged
  token's is derived from its Solana mint, with a prefix of its own: the asset id of the
  denom `uxmr20open` followed by the 64 hex characters of the token id (a bridged token's
  denom starts `uxmr20private`).

The same text signed by the same address has the same record id, and the ledger takes a
record once. Whoever wants a second token with the same ticker and numbers changes a field
(the name, for example) or signs with another address.

## 6. Supply

The supply of an open token comes into being in two ways and in no other.

**The creator's share.** When the deploy is applied, `pre` whole tokens are credited as one
Open note to the creator's address: the note's owner is the address owner that sign to
move defines for a Monero address (`owner(B, A)`), and its id is
`note_id(token id, 0)`. The creator moves it like any note held by a Monero address, with a
signed move (`XW1`).

**Mint records.** A new record of the token ledger:

```
XO1 mint:  "XO1" 0xfe  asset(32)  amount(u64)  owner(32)  salt(8)
```

- `asset` is an open token's asset id; `amount` is in the smallest unit; `owner` is the
  owner key that receives the note (a wallet's owner key, or the address owner of a Monero
  address); `salt` is any 8 bytes.
- The record has **no signature**. Whoever gets it into a block mints, to whatever owner the
  record names. A copy of the record carried by someone else has the same bytes and the
  same id and counts once, for the same owner.
- It is applied when, in chain order, it comes after the token's deploy, `amount` is at
  least 1 and at most `lim` whole tokens, something is left to mint, and no record with the
  same bytes was applied before.
- It credits `amount`, or what is left when less than `amount` is left, as one Open note
  with id `note_id(record id, 0)`. Left to mint is `max` minus `pre` minus everything
  minted so far. When nothing is left, mint records are refused.
- One transaction carries one record. The same owner can mint as often as they like: each
  record needs another `salt`.

So the supply of an open token is never above `max`, and anyone can check it from the
chain: `pre` plus the mint records applied, minus what was burned.

There is no mint fee in the rules. A mint costs the Monero network fee of the transaction
that carries it. A relay may charge for carrying records; that is the relay's own price.

## 7. Moving, trading and burning

Every record that moves a token works for an open token's asset as it does for any other,
with no change: transfers between XMR20 wallets (`XP1`), moves signed by a plain Monero
address in Feather, Cake Wallet and others (`XW1`), listing and buying on the Monero
market (`XT1` and the market records), and the rest. A wallet, an explorer or a market
that reads the token ledger shows open tokens without a special case.

**Signed texts name the token by ticker and id.** Tickers repeat, so a text that a person
signs in a Monero wallet (a move, a listing, a reservation) says which token it means. For
an open token the text writes the token as

```
<ticker> (token <the first 16 hex characters of the token id>)
```

for example `XMR20 move: send 5 PEPE (token 3f9a1c0be27d4a66) to …`. The record's ticker
field holds the deploy's `tick` when that is 1 to 12 letters or digits (the field takes
nothing else), and `TOKEN` for any other ticker. A reader rebuilds the text from the
record and the token's deploy; a record of an open token whose ticker field is anything
else is refused. Sixteen characters, not fewer, so that nobody can make a second token
whose id starts the same way. The texts of bridged tokens stay as they are.

A burn (`XR1`) of an open token destroys the tokens for good. Nothing redeems them.

## 8. What cannot happen

- A bridge credit (`XC1`) for the asset of an open token is refused. The issuer key can
  never make supply of an open token.
- A mint record (`XO1`) for an asset that is not an open token's is refused. Nobody can
  mint a bridged token.
- A mint record in a block before the opening block is nothing, as for a reader without
  these rules. One that comes before its token's deploy is refused; the same record carried
  again after the deploy mints.
- A burn of an open token is listed with the other burns. A bridge that pays out on burns
  looks an asset up among the bridged tokens only.
- A deploy is refused when its asset already has supply on the ledger. An asset id cannot
  be told apart by its bytes, so the issuer key could sign a credit for the asset of a
  deploy it has seen waiting for a block and get the credit in first. The deploy then makes
  no token (the credited notes are notes of an asset no deploy names), and the creator
  deploys again with another field. The issuer can hold a deploy up this way, in public and
  under its own signature; it cannot add to the supply of a token that exists.

## 9. Bridges are services

An open token lives on Monero. Taking it to another chain is a service somebody runs, not
part of these rules: the service holds tokens at an address or owner key of its own on
Monero and gives out a wrapped token elsewhere, and gives the tokens back when the wrapped
ones are returned. Readers see only ordinary moves to and from that address. Any number of
such services can exist, and none of them can change a token's supply on Monero.

## 10. What a reader does

A reader of open tokens follows both ledgers from its own Monero node:

- from the XMR721 ledger it takes the deploys, in order (it needs the mint records only, not
  the owners of NFTs);
- from the token ledger it takes credits, mints and every move, and holds the notes.

Blocks that are replaced are undone in both, and the result depends only on the chain.
Readers treat 10 blocks as final.

Routes of this repository's reader, with `--xmr20-open-from <opening block>` (**draft**):

- `GET /xmr20/open?from=&limit=`: the open tokens, newest first, each with `number`, `kind`
  (`open`), `id`, the deploy's fields, `creator`, `label` (how signed texts name it),
  `height`, `txid` and `confirmations`.
- `GET /xmr20/open/<id | the first 16 characters of the id>`: one token, with its deploy
  record and its text.
- `GET /info` names the opening block under `xmr20.open`.

The bridged tokens stay where they are: `/xmr20/tokens` and `/xmr20/earlier`.

This reader lists what was announced. What was minted, what is left and who holds a token
is the token ledger's to say: the wallet engine answers `openTokens` with `minted`, `left`
and `mints` for each token, and holds the notes. The one deploy the token ledger refuses
and this list shows is the one of section 8 (its asset already had supply).

Every reader has to know `XO1` and the open deploy before the opening block: a reader that
does not would ignore them and hold other balances from that block on. That includes the
engine in wallets and the one the checkpoint repository pins.

## 11. Open points

1. **The opening block** is set: 3,812,510 on mainnet. A reader is started with
   `--xmr20-open-from 3812510`.
2. **The signed texts of open tokens** (section 7) are a new form of the move and trade
   texts. Their exact wording, record by record, is to be written out with the engine's
   code and test vectors. For bridged tokens the rules still do not compare the ticker
   field with the token's deploy; whether they should is a separate question.
3. **Mints cost only the network fee** (about 0.00004 XMR at the time of writing), and a
   Monero address is free. A popular token can be minted out by one script in a few
   blocks, as on Bitcoin. A limit per person is not possible. A mint price paid to the
   creator would slow this and is not in this draft.
4. **Who can mint in practice.** A mint record needs a transaction with the record in its
   extra field. The `xmr721` wallet in this repository makes one (`xmr20 mint`, the same as `xmr721 wallet mint`),
   and deploys (`xmr20 deploy`). Feather and Cake cannot write a record into a
   transaction, so their users mint and deploy through a relay: a mint needs no signature,
   a deploy one signed message (section 12). A relay charges for both.
5. **Not built yet.** The rules are in the token ledger's core, in the wallet engine built
   on it and in this repository's library and reader (section 12). Still to do: the list of
   record transactions wallets start from on the indexer's side (it has to carry deploys
   and mints), the wallets' screens and a page for the relay's routes, the checkpoint
   repository's engine, and a run on a test network.
6. **Private (shielded) notes of open tokens**: by section 7 they work as for any asset;
   to be confirmed against the engine before the opening block.
7. **The market records with a coin anchor** (`XA1`, `XL1`, offers) carry no ticker and no
   signed text; they take an open token's asset as any other. To be confirmed with a test.
8. **Mining reward transactions.** Whether a record in a mining reward transaction counts
   has to be the same for the token ledger's scanner and the XMR721 reader; to be checked
   when the engine is built.
9. **A credit that gets in before a deploy** (section 8) holds that deploy up. Whether that
   is acceptable, or the asset id should depend on something the issuer cannot know in
   time, is open.

## 12. Code and test cases

- `xmr20-tokens/lib/open.mjs`: the deploy text, which mint records are open deploys, how a
  signed text names a token. Tests: `node --test xmr20-tokens/tests/open.test.mjs`.
- `xmr20-tokens/tests/open-fixtures.json`: mint records made and signed with this
  repository's rule library, each with what a reader makes of it (a deploy with its id,
  signed text and label, or not a deploy and why). Written by
  `xmr20-tokens/tools/open-fixtures.mjs`; any implementation can replay them.
- The token ledger's core (Rust, `open.rs` and the pool): the deploy as the ledger reads
  it, the creator's share, `XO1`, the refusals of section 8 and the signed texts of
  section 7. Its tests replay the same file and cover the supply rules: the last mint, a
  mint before its deploy, a record carried twice, a deploy before the opening block, a
  credit for an open token.
- The wallet engine built on that core: it takes deploys and mints from the blocks it reads
  and from saved progress, passes over every other XMR721 record, lists the tokens
  (`openTokens`) and makes mint records (`openMintRecord`). A test drives the built engine
  with the shared test cases and compares it with the engine it was built from on the
  records that exist today.
- `reader/service.mjs`: the routes of section 10, from the records the reader's journal
  holds.
- `cli/`: `xmr20 deploy` and `xmr20 mint` (`cli/xmr20.mjs`, the `xmr721` wallet's `deploy` and `mint` under their own name). The carrier tool
  (`reader/carrier`) makes the mint record: the token's asset id and the owner key of a
  Monero address, checked against values of the token ledger's core. On a local test chain
  a token deployed and minted by this wallet in real transactions is the same token, with
  the same balances, for the reader and for the wallet engine.
- `reader/lib/relay.mjs` and the reader's routes, for wallets that only sign messages:
  `POST /xmr20/open/deploy-text` gives the one line a creator signs in Feather or Cake
  Wallet, `POST /xmr20/open/deploys` takes the signature and hands the record to the relay
  like any other; `POST /xmr20/open/mints` asks the relay to carry a mint to an address (or to a wallet's
  owner key, `wallet`) for
  its fee (`--token-mint-fee`), with no signature, and `GET /xmr20/open-mint/<id>` says what
  became of it. A mint is paid for before it is sent, never charged twice, and settled by
  the node; what it credited is the token ledger's to say. On a local test chain a wallet2
  wallet deployed by signing, minted by paying the relay, and moved tokens by signing.
- Two independent reviews were made of this draft's code, one of the supply rules and one
  comparing the two implementations input by input (every code point, about 32,000 texts
  and 17,000 signed records). Their tests are kept with the core's tests; what they found
  (the order of the carrier field, two ids that start alike, the transport functions
  knowing the new records at every height) is fixed in this draft.
