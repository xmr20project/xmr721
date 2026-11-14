# Earlier XMR20 deploy inscriptions

Before XMR20 tokens were inscribed on the XMR721 ledger ([FORMAT.md](FORMAT.md)), the
launchpad announced each token on Monero in a format of its own: one signed deploy record in
the extra field of one transaction. Those inscriptions are on the chain for good. This
document says how they are read, so that anyone's XMR721 reader lists the same tokens, and
how the list this repository ships was made and can be checked.

Nothing new is written in this format here. It is read only.

The code in [`lib/earlier.mjs`](lib/earlier.mjs) is this document as code.

## Where an inscription sits

In the extra field (`tx_extra`) of an ordinary Monero transaction, in nonce fields that
start with `"XM2"`, the same carrier fields the XMR20 NFT format uses
([`../xmr20-nfts/FORMAT.md`](../xmr20-nfts/FORMAT.md), section 1):

```
"XM2"  index(u8)  count(u8)  carrier bytes
```

The fragments' carrier bytes joined are the **carrier**. For a deploy it is at most 800
bytes:

```
carrier = "XMR20M1"  JSON text of {"record": …, "signature": …}
```

The JSON text is plain ASCII and written one way only: keys in order, no spaces. A text
that is written any other way is not an inscription.

## The record

| Field | |
|---|---|
| `p` | `"xmr20"` |
| `v` | `1` or `2` |
| `net` | `"mainnet"` |
| `op` | `"deploy"` |
| `owner` | the deployer: the Monero address that signed |
| `tick` | the ticker, 1 to 10 capital letters and digits, a letter first |
| `mint` | the token's Solana mint address |
| `creator` | the Solana address that launched it |
| `chain` | `"mainnet-beta"` for version 1, `"mainnet"` for version 2 |
| `max` | `"1000000000000000"`: one billion tokens with 6 decimals |
| `initial` | `"0"` |
| `fee` | `"150"` or `"200"` |
| `nonce` | 32 hex characters |
| `meta` | 64 hex characters, the hash of the token's name, description and picture |

No other field is allowed.

`signature` is a Monero message signature (`SigV2…`, made with the spend key) by `owner`
of this text:

```
version 1:  "MOUSE-ROAD-XMR20-MAINNET-DEPLOY-V1\n"  + the record's JSON text
version 2:  "XMR20-MAINNET-DEPLOY-V2\n"             + the record's JSON text
```

The first line is part of what was signed; it is kept as it was written on the chain.

## Which inscriptions are tokens

A reader is given the **deployers**: the addresses whose deploy inscriptions count. The
launchpad signed all of its deploys with one address:

```
4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM
```

Going through the chain in order, every transaction whose extra field holds a deploy
inscription signed by a deployer is a deploy. The token of a Solana mint is its earliest
deploy; a later deploy for the same mint is kept in the list and is no token. Tokens are
numbered from 1 in that order.

Every one of these tokens has a supply of one billion with 6 decimals and was launched on a
Solana bonding curve. A deploy says nothing about balances.

## The shipped list

[`earlier/deploys.jsonl`](earlier/deploys.jsonl) holds every deploy inscription of the
deployer above from the first XMR20 block (3,772,610) to the XMR721 ledger's start block
(3,804,029): 80 inscriptions, 80 tokens, the first in block 3,772,641 and the last in block
3,799,968. It holds what is on the chain, also the launchpad's own early test launches,
which its pages do not show. One per line in chain order: its transaction id, its block and
that block's time, and the JSON text that is inscribed.
[`earlier/list.json`](earlier/list.json) names the range, the hash of the range's last
block, the deployers, the number of entries and the file's SHA-256.

A reader loads the list at start and checks every line again: the text is written the one
way it can be, the record is a deploy, the signature is the deployer's. A list that fails
does not load.

It was made by reading every block of the range from a Monero node:

```
node xmr20-tokens/tools/earlier.mjs scan --node <your node> --from 3772610 --to 3804029 \
  --deployer 4AMg1kDaXk…NsBtCkMLiNM --out <a new folder>
```

and anyone can make it again the same way and compare the two files, or, much faster, read
every listed transaction again from their own node:

```
node xmr20-tokens/tools/earlier.mjs check --node <your node>
```

The check shows that what is listed is on the chain as listed. Only the scan shows that
nothing was left out.

## What a reader serves

A mainnet reader serves the shipped list unless told otherwise (`--no-xmr20-earlier`, or
`--xmr20-earlier <folder>` for another list):

- `GET /xmr20/earlier?from=&limit=`: the list's block range and deployers, and the earlier
  tokens, newest first, each with `number`,
  `tick`, `max`, `dec`, `mode`, `mint`, `creator`, `deployer`, `version`, `txid`, `height`,
  `time`, and `earlier: true`.
- `GET /xmr20/earlier/<transaction id | mint | number>`: one token with its record, its
  signature and the inscribed text.
- `GET /xmr20/tokens` says how many earlier tokens there are (`earlier`), and `GET /info`
  names the list's range and deployers.

A token launched since has its deploy inscription on the XMR721 ledger and is listed under
`/xmr20/tokens`. A launch can have both kinds of inscription; they name the same Solana
mint, and a page shows it once.

## Not covered

Deploys in this format made after the list's last block are not read: the list ends at the
XMR721 ledger's start block, and the reader does not yet look for this format in the blocks
it follows.
