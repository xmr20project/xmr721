# XMR20 tokens on XMR721

XMR721 is the ledger of inscriptions on Monero: the Mordinals, and the NFTs minted since
(RULES.md). An XMR20 token is announced on that ledger by one inscription, the way a BRC-20
token is announced by an inscription on Bitcoin: a short JSON text that says the token
exists and what it is called.

This document says what that text is and which inscriptions a reader lists as tokens. It
adds no rule to the ledger. A deploy inscription is an ordinary minted NFT (RULES.md
section 9); the token list is a view a reader computes from the ledger, like the
collections.

## The deploy text

```json
{"p":"xmr20","op":"deploy","tick":"TEST2","name":"Test Two","max":"1000000000","dec":"6","mode":"monero-curve","mint":"BGqUfSkAitpr6jErdEswXwYSXrf21gfCaBNh1h45HMBL"}
```

| Field | | Meaning |
|---|---|---|
| `p` | required | `"xmr20"` |
| `op` | required | `"deploy"` |
| `tick` | required | the ticker, 1 to 32 characters |
| `name` | optional | the token's name, 1 to 64 characters |
| `max` | required | the supply in whole tokens: 1 to 30 digits with no leading zero, written as text |
| `dec` | required | decimals, `"0"` to `"18"` |
| `mode` | required | how the token was launched: 1 to 32 characters, words of lower-case letters and digits joined by single hyphens |
| `pair` | optional | what the launch trades against, 1 to 16 letters or digits |
| `mint` | optional | the token's Solana mint address |
| `col` | optional | the id of an XMR721 collection that belongs to the token |

Modes in use: `monero-curve` (the curve runs on Monero), `bonding-curve` (a Solana bonding
curve; `pair` is `wXMR` or `XMR20`), `sweep-burn` (`pair`, and `col` for its NFTs). A
reader shows a mode it does not know as it is written.

Every value is text. The text is UTF-8 without a byte order mark and at most 600 bytes.

`tick` and `name` may be in any script. Their lengths are counted in characters (code
points). They have no space at either end, and none of the characters that do not show or
that change how the text around them shows: control and formatting characters, direction
marks, joiners, variation selectors, blank look-alikes, every space but U+0020, private-use
code points and noncharacters. The list is fixed, so that every reader refuses the same
texts whatever Unicode tables it has:

> U+0000–U+001F, U+007F–U+00A0, U+00AD, U+034F, U+0600–U+0605, U+061C, U+06DD, U+070F, U+0890–U+0891, U+08E2, U+115F–U+1160, U+1680, U+17B4–U+17B5, U+180B–U+180F, U+2000–U+200F, U+2028–U+202F, U+205F–U+206F, U+2800, U+3000, U+3164, U+E000–U+F8FF, U+FDD0–U+FDEF, U+FE00–U+FE0F, U+FEFF, U+FFA0, U+FFF0–U+FFFF, U+110BD, U+110CD, U+13430–U+1343F, U+1BCA0–U+1BCA3, U+1D173–U+1D17A, U+1FFFE–U+1FFFF, U+2FFFE–U+2FFFF, U+3FFFE–U+3FFFF, U+4FFFE–U+4FFFF, U+5FFFE–U+5FFFF, U+6FFFE–U+6FFFF, U+7FFFE–U+7FFFF, U+8FFFE–U+8FFFF, U+9FFFE–U+9FFFF, U+AFFFE–U+AFFFF, U+BFFFE–U+BFFFF, U+CFFFE–U+CFFFF, U+DFFFE–U+DFFFF, U+E0000–U+E0FFF, U+EFFFE–U+EFFFF, U+F0000–U+10FFFF

A name that holds one of these (an emoji joined from several, for example) cannot be
written; the launch inscriber then leaves the name out, and the ticker stands alone.

**One deploy has one text.** The fields are written in the order of the table, without
spaces, and nothing else is in the object. A reader reads only that exact text: the same
fields in another order, with spaces, with a field twice or with a field it does not know
are not a deploy. Every reader therefore agrees on what an inscription says.

A deploy says nothing about balances, and names no creator and no wallet. Balances and
trades stay where the token lives (its Solana mint, the market it trades on).

## The inscription

A deploy is inscribed as a mint record (op 8):

- no collection (`collection32` is zero, `edition` 0),
- `type` 6 (JSON),
- `content` is the deploy text,
- `name` is the ticker when it is printable ASCII, otherwise empty,
- signed by the inscriber, who is also its first owner.

It is an NFT like any other on the ledger: it has an id, an owner, and can be moved or
burned.

## Which inscriptions are tokens

A reader is given a list of **inscribers**: the addresses whose deploy inscriptions count.
A launchpad inscribes its launches with its own address, so a launch is a token whatever
wallet started it, and a copy of a deploy text inscribed by anyone else is an NFT and not
a token.

Going through the minted NFTs in ledger order, a reader takes every NFT that

1. was minted by an inscriber,
2. is in no collection and has type 6,
3. has content that is exactly a deploy text.

Each of these takes the next **token number**, starting at 1. It is listed as a token
unless

- its inscriber has burned it (it is **withdrawn**), or
- it names a `mint` that an earlier listed token already names.

So a Solana mint has at most one token: the earliest deploy inscription that still stands.

Only the inscriber takes a token back, by burning the inscription while it holds it. An
inscription the inscriber has moved to another owner is that owner's NFT: they can burn the
NFT, and the token stays listed (marked `burned`), with its mint still taken.

An inscriber corrects a mistake by burning the inscription and inscribing the token anew;
the burned one keeps its number and the new one gets the next. The new text has to differ
from the burned one in a field: a record with the same content by the same inscriber has
the same id, and the ledger takes a record once.

Numbers follow the order of the ledger, so they are final when their block is: while a
block can still be replaced (readers treat 10 blocks as final), the inscriptions in it can
come back in another order and take other numbers.

Tickers are not unique. A token is known by its inscription id, and by its mint when it
has one.

Moving the inscription to another owner changes nothing here: the token is the
inscriber's inscription, whoever holds it.

## Inscription numbers

The Mordinals keep their numbers. For display, a reader counts minted NFTs on from there
in ledger order: the first minted NFT has the number after the last Mordinal. Records
never use this number; they name an NFT by its id.

## Reader routes

With `--xmr20-inscribers <address>,…` the reader service answers:

- `GET /xmr20/tokens?from=&limit=&mode=`: the tokens, newest first, each with `number`,
  the deploy's fields, `inscriber`, `id`, `inscription`, `owner`, `height`, `time`,
  `txid` and `confirmations`.
- `GET /xmr20/token/<id | number | mint>`: one token, with its mint record and its text.
- `GET /xmr20/deploys/<mint>`: every deploy inscription that names this mint, each with
  `listed`, `burned` and its record: also the withdrawn ones and those behind an earlier one.
- `GET /address/<address>/records`: every collection and mint record of one signer that the
  relay knows, in any state, with its bytes.
- `GET /nft/<id>/content`: the inscribed text, as JSON.
- `GET /info`: lists the inscribers under `xmr20`.

## The launch inscriber

`inscriber/run.mjs` follows the public launch lists and inscribes a deploy for every new
launch through a relay:

- launches on the Monero curve, from the trading service's `/api/launches`;
- launches on the Solana bonding curve, from the launch list, once Solana has finalized
  them.

It holds one key, which signs mint records and nothing else, and no coin: the relay carries
its records. It keeps a journal, so it can be stopped at any point; a launch's record has
one id however often it is made, and the index lists one token per mint.

A launch is inscribed once, also when the journal is lost. Before a record is made for a
launch, the inscriber asks what already exists for its mint: a deploy inscription on the
ledger (`/xmr20/deploys/<mint>`) is taken over as it is, and one its inscriber burned stays
withdrawn (inscribing that launch anew is a person's decision); a record the relay still
knows in any state, waiting or given up on (`/address/<address>/records`), is taken over
as the launch's record, whatever the launch list says by then. It does not start on an
index that cannot answer these two questions, and a journal folder belongs to one running
inscriber.

The relay holds a launch for the first deploy record it takes for a signer and a Solana
mint: while it knows that record (in any state but refused), it takes no other record for
the same signer and mint, and says which record holds the launch. Records are taken one at
a time, so two runs of one inscriber cannot both get a record in; the one that is refused
takes the other's record over. A burned inscription holds nothing, so a launch can still
be inscribed anew by hand.

What is inscribed stays on the chain, so the inscriber holds back rather than guess:

- `--since` sets the time from which launches are inscribed; earlier launches are left
  alone. A time more than two days back needs `--backfill`.
- A launch it cannot describe fully and for certain is left out and logged: no whole
  supply, a venue or flow it does not know, a launch the launch list itself hides or halts,
  a mint listed on two rows, a time that is not in milliseconds.
- The supply is the launch's own (for a launch on the Monero curve: what is listed now plus
  what was burned when its pool opened), never a present default. The launch list and the
  markets are two reads; a launch they do not show in the same phase waits for the next
  pass.
- It makes at most `--per-day` records in 24 hours (50), oldest launch first across all
  lists; every launch it has seen stays in its queue until its record is made, so launches
  past the bound go out on the following days and none is passed over. A launch is
  inscribed with the fields it had when it was first seen. A launch its list does not show
  in a pass is set aside (not made while away, not new when it is back) and leaves the
  queue after 30 days; which launches it has ever queued it remembers for good, so one
  that comes back later still is not new either.
- It takes nothing new from a list that shows more than `--burst` launches it has not seen
  before in one pass (20) until a person has looked; what it has seen keeps going out.
- A new journal waits two blocks before its first record.
- It waits while the ledger does not list its address as a minter or the index does not
  list it as an inscriber.
- Only a refusal by the rules closes a record (after three); a busy or failing relay is
  tried again, and a record the relay gave up on is offered again every 20 blocks.
- Every argument of the command has to be a known one; a mistyped one stops it.

`--preview` prints the texts it would inscribe, and what it would leave out and why. It
reads the lists and nothing else: no key, no journal, nothing signed or sent.

Tests: `node --test xmr20-tokens/tests/*.test.mjs` (offline).
