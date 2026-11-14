# XMR20 NFTs

The NFT collections the XMR20 project inscribed on Monero in 2026, starting with GENESIS,
and the rules that decode them. They use their own format,
[XMR20-NFT-V2](FORMAT.md), which is separate from the Mordinals rules: an NFT here is owned
by a Monero address from the moment it is minted and moves by a signed record.

This is a legacy format. New inscriptions are planned to use XMR721
([`../RULES.md`](../RULES.md)).

## GENESIS

100 small renderings of well-known paintings, editions 1 to 100, minted between blocks
3,777,792 and 3,778,737 (October 2026). 90 are palette pictures, 10 are WebP.

| | |
|---|---|
| Collection id (deploy transaction) | `48c2e05b20e3a704f374ed5bbae1c17b45523ed0ad1d0db772c05187a53b87e0` |
| Deployed at block | 3,777,782 |
| Minted | 100 of 100 |
| Transfers up to block 3,804,029 | 0: every edition was still at the address it was minted to |

- [`collections/genesis.json`](collections/genesis.json): the collection, the block the
  owners were read at (`ownersAsOf`: block 3,804,029, where an XMR721 reader starts) and
  the blocks that were scanned for it.
- [`collections/genesis.jsonl`](collections/genesis.jsonl): one line per edition with its
  mint transaction, block, name, attributes, picture codec and size, `art` hash, owner and
  latest transaction.
- [`collections/genesis-transactions.json`](collections/genesis-transactions.json): the raw extra field
  of the deploy and the 100 mint transactions, so the two files can be rebuilt offline.
- [`collections/genesis-txids.txt`](collections/genesis-txids.txt): the ids of those 101
  transactions, one per line, for rebuilding the collection from your own node (below).

## How the files were made

By reading every block from the first XMR20 block to the block an XMR721 reader starts at,
and keeping the collection's transactions: its deploy, every mint that names it, every
transfer of one of its NFTs.

```
node xmr20-nfts/tools/scan-collection.mjs --node <your node> --from 3772610 --to 3804029 \
     --collection 48c2e05b20e3a704f374ed5bbae1c17b45523ed0ad1d0db772c05187a53b87e0 --out genesis-scan.json
node xmr20-nfts/tools/build-collection.mjs --scan genesis-scan.json --name genesis \
     --extras xmr20-nfts/collections/genesis-transactions.json
```

The scan keeps the deploy, every mint that names the collection and every transfer of an
NFT that such a mint, earlier in the chain, made. It found the 101 transactions listed in
`collections/genesis-txids.txt` and no other. The second command decodes and judges them
with the code in [`lib/`](lib): framing, the one-spelling rule, each signature, each
picture, and the ownership rules. Anyone can run both against their own node; the three
files come out byte for byte as they are here (`git diff` shows nothing).

What the scan does not read is the records of other collections. The nonce rule spans every
collection of the format, so a nonce that one of these records' signers had used before in
a record of another collection would not be noticed here.

Much faster, without a scan: read only the 101 listed transactions from a node.

```
node xmr20-nfts/tools/build-collection.mjs --node <your node> --name genesis \
     --collection 48c2e05b20e3a704f374ed5bbae1c17b45523ed0ad1d0db772c05187a53b87e0 \
     --txids xmr20-nfts/collections/genesis-txids.txt
```

`collections/genesis.jsonl` comes out the same. `collections/genesis.json` then names no
block for the owners, because the listed transactions alone do not show that nothing else
touches the collection; put it back with `git checkout`.

## What a reader does with it

An XMR721 reader started with `--collections xmr20-nfts/collections` serves the collection
(`/collections`, `/collections/genesis`, `/collections/genesis/<edition>`) and draws every
NFT the way it is meant to be seen, its own text over its picture
(`/collections/genesis/<edition>/picture`; `?plain=1` gives the bare picture). The ten WebP
pictures need the optional `sharp` package, which `npm install` adds.

A mainnet reader also keeps the owners current. The files end at its start block, so from
there it looks for transfers of these 100 NFTs in every block it has read
([`../reader/lib/earlier.mjs`](../reader/lib/earlier.mjs)), and applies them by the
[ownership rules](FORMAT.md) once they are 10 blocks deep. `/collections/genesis` then
gives each NFT's owner, latest transaction and number of transfers as of the block named
in `ownersAsOf`; `following` says whether that is the newest block the reader holds
(`complete`) and how many transfers are not deep enough yet (`pending`).
`/collections/genesis/<edition>` lists the NFT's moves. This needs no picture decoder, and
`--no-xmr20-follow` turns it off. A transfer signed by someone who does not own the NFT is
kept in the reader's folder like any other signed transfer of it, and moves nothing.

Only this collection is read. The nonce rule spans every collection of the format, so a
nonce the same signer used in a record of another collection is not seen here. And only
the three kinds of record in [FORMAT.md](FORMAT.md) are known: should the format ever get
another kind of record that moves an NFT, this reader would not see such a move until its
rules are brought up to date.

## Tools and tests

```
node xmr20-nfts/tools/decode.mjs --node <monero node url> --tx <txid> [--png picture.png]
node xmr20-nfts/tools/scan-collection.mjs --node <monero node url> --collection <deploy txid> --from <height> --to <height> --out <file>
node --test xmr20-nfts/tests/nfts.test.mjs
node --test reader/tests/follow.test.mjs
```

`decode.mjs` prints the record in one transaction, says whether its signature is valid and
writes a mint's picture. `scan-collection.mjs` finds a collection's transactions by reading
the blocks. The first tests rebuild the collection files from the saved transactions,
decode every picture, and run the ownership rules on made-up records with throwaway keys;
the second are those of the reading on: the follower, transfers, the scan.

## Other collections

The same format carries other collections. They are not part of this index; the tools
above build any of them from its deploy transaction id.
