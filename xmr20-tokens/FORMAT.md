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
| `max` | required | the supply in whole tokens, a decimal number written as text |
| `dec` | required | decimals, `"0"` to `"18"` |
| `mode` | required | how the token was launched: lower-case words joined by hyphens |
| `pair` | optional | what the launch trades against, 1 to 16 letters or digits |
| `mint` | optional | the token's Solana mint address |
| `col` | optional | the id of an XMR721 collection that belongs to the token |

Modes in use: `monero-curve` (the curve runs on Monero), `bonding-curve` (a Solana bonding
curve; `pair` is `wXMR` or `XMR20`), `sweep-burn` (`pair`, and `col` for its NFTs). A
reader shows a mode it does not know as it is written.

Every value is text. `tick` and `name` may be in any script; they have no control,
formatting or direction characters and no space at either end. The text is at most 600
bytes.

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

Each of these takes the next **token number**, starting at 1, for good. It is listed as a
token unless

- it has been burned, or
- it names a `mint` that an earlier listed token already names.

So a Solana mint has at most one token: the earliest deploy inscription that still stands.
An inscriber corrects a mistake by burning the inscription and inscribing the token anew;
the burned one keeps its number and the new one gets the next.

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
one id however often it is made, and the index lists one token per mint, so a launch is
not inscribed twice. `--since` sets the time from which launches are inscribed; earlier
launches are left alone. `--preview` prints the texts it would inscribe and sends nothing.

Tests: `node --test xmr20-tokens/tests/*.test.mjs` (offline).
