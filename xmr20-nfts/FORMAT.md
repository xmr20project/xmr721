# XMR20 NFT format (XMR20-NFT-V2)

The format of the NFT collections the XMR20 project inscribed on Monero in 2026, GENESIS
among them. It is written down here so that the collections can be read and checked by
anyone. It is a legacy format: new inscriptions are meant to use a different one, and
nothing in the Mordinals rules ([`../RULES.md`](../RULES.md)) depends on it.

The code in [`lib/`](lib) is this document as code.

## 1. Where a record sits

One record sits in the extra field (`tx_extra`) of one ordinary Monero transaction. The
extra field is at most 1,060 bytes and may hold only these fields:

| Tag | Field |
|---|---|
| `0x00` | padding (at most 255 bytes, to the end) |
| `0x01` | transaction public key, 32 bytes |
| `0x02` | nonce: a length, then that many bytes (at most 255) |
| `0x04` | additional public keys: a count (at most 32), then 32 bytes each |

Any other tag, a truncated field or a length written in more bytes than needed means the
transaction holds no NFT record.

A nonce field whose bytes start with `"XM2"` is a **fragment**:

```
"XM2"  index(u8)  count(u8)  up to 250 carrier bytes
```

There are at most 5 fragments. They appear in order (`index` 0, 1, …), each states the same
`count`, and all but the last have the same size. Their carrier bytes joined are the
**carrier**, at most 984 bytes. Other nonce fields (a wallet's payment id, for example) are
ignored.

## 2. Carrier

```
carrier = "XMR20T2"  raw DEFLATE of the UTF-8 text  JSON.stringify({record, signature})
```

- The inflated text is at most 16,384 bytes and no byte may follow the compressed data.
- The text must be valid UTF-8 and must be exactly what `JSON.stringify` writes for the
  value it parses to: no spaces, no duplicate keys. Key order is kept as written; it is
  part of what is signed.
- A reader never compresses the text again to compare bytes. Different compressors give
  different bytes for the same text.

## 3. Records

Every record has `p: "xmr20"`, `v: 2`, `net: "mainnet"`, `op`, `owner` (the signer, a
standard Monero address starting with `4`) and `nonce` (32 hex characters). Text fields are
printable ASCII. No field beyond the ones listed is allowed.

| `op` | Further fields |
|---|---|
| `nft_deploy` | `name` (1–80 characters), `max` (1–10,000), `meta` (64 hex) |
| `nft_mint` | `collection_id` (the deploy transaction id), `edition` (1–10,000), `to` (address), `name` (1–160), `collection` (1–80), `description` (0–500), `attributes`, `image` |
| `nft_transfer` | `token` (the mint transaction id), `prev` (the token's latest transaction id), `to` (address, not the signer) |

`attributes` is an object of at most 24 text pairs (key at most 32 characters, value at
most 240) and must include `editions`, written `"<edition>/<max>"`.

`image` is at most 128 wide, 192 high and 24,576 pixels, with at most 12,000 characters of
plain base64 in `data`:

| `codec` | Fields | Picture |
|---|---|---|
| `json-text-1` | `width`, `height`, `palette` (2, 4, 8 or 16 colours as 6 hex digits), `encoding: "range-base64"`, `data` | One palette index per pixel, row by row, packed with the range coder in [`lib/map-codec.mjs`](lib/map-codec.mjs). Decoding and encoding again must give the same bytes. |
| `json-text-webp-1` | `width`, `height`, `encoding: "base64"`, `data` | A WebP file: one still frame of exactly that size, no transparency, decoding without error. |

## 4. Signature

`signature` is a Monero message signature (`SigV2…`, 93 characters) made by the **spend
key** of `owner` over the text

```
"XMR20-NFT-V2\n" + lowercase hex SHA-256 of JSON.stringify(record)
```

with the record's keys in the order they were written. It is what "sign message" in a
Monero wallet produces. A signature made with the view key is refused. `owner` and `to`
must be standard mainnet addresses with a correct checksum; subaddresses and integrated
addresses are refused.

## 5. Ownership

Records are applied in chain order (block, then position in the block) once they are 10
blocks deep. A record that fails any check changes nothing.

- A signer may use a `nonce` once, across all operations and all collections.
- **Deploy** creates a collection. Its id is the deploy transaction id, its authority is
  the signer.
- **Mint** needs the collection to exist, the signer to be its authority, `collection` to
  be its name, an `edition` not above `max` and not minted before, `attributes.editions`
  to match, and a valid picture. The NFT's id is the mint transaction id and its owner is
  `to`.
- **Transfer** needs the signer to be the current owner and `prev` to be the NFT's latest
  transaction id (its mint, or its latest transfer). The owner becomes `to`.

`art`, the hash that identifies the artwork, is the SHA-256 of
`JSON.stringify({name, collection, description, attributes, image})` from the mint record.

Ownership is a rule of this ledger. It is not tied to any coin, and the transaction that
carries a record can be paid by anyone.

## 6. How the website draws them

Not part of the format. xmr20.org draws a mint as the record's own JSON text in an 8×12
pixel font, each character coloured from the decoded picture underneath, and offers larger
companion images that are not on chain. [`tools/decode.mjs`](tools/decode.mjs) writes the
plain decoded picture.
