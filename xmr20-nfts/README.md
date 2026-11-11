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
| Transfers so far | 0: every edition is still at the address it was minted to |

- [`collections/genesis.json`](collections/genesis.json): the collection and the block the
  owners were read at.
- [`collections/genesis.jsonl`](collections/genesis.jsonl): one line per edition with its
  mint transaction, block, name, attributes, picture codec and size, `art` hash, owner and
  latest transaction.
- [`collections/genesis-transactions.json`](collections/genesis-transactions.json): the raw extra field
  of the deploy and the 100 mint transactions, so the two files can be rebuilt offline.

## How the files were made

```
node xmr20-nfts/tools/build-collection.mjs --node <monero node url> --name genesis \
     --collection 48c2e05b20e3a704f374ed5bbae1c17b45523ed0ad1d0db772c05187a53b87e0 \
     --reader https://indexer2.xmr20.org/api/xmr20 --extras xmr20-nfts/collections/genesis-transactions.json
```

Every transaction is read from the Monero node, decoded and judged with the code in
[`lib/`](lib): framing, the one-spelling rule, each signature, each picture, and the
ownership rules. The project's reader service is asked only *which* transactions belong to
the collection; the owners it reports are then compared with the owners worked out here,
and the run stops on any difference.

What this does not show by itself: that no other transaction on the chain touches the
collection. That needs a scan of every transaction from block 3,777,673 on, which the
reader service does and this repository does not do yet. The nonce rule also spans all
collections, so a full check has to read every XMR20 NFT record, not only GENESIS.

## Tools and tests

```
node xmr20-nfts/tools/decode.mjs --node <monero node url> --tx <txid> [--png picture.png]
node --test xmr20-nfts/tests/nfts.test.mjs
```

`decode.mjs` prints the record in one transaction, says whether its signature is valid and
writes a mint's picture. The tests rebuild the collection files from the saved
transactions, decode every picture, and run the ownership rules on made-up records with
throwaway keys.

## Other collections

The same format carries other collections (AFTERIMAGE and others). They are not listed
here yet; the tool above builds any of them from its deploy transaction id.
