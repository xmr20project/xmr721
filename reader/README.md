# Reader, relay and service

The programs that run XMR721 on the Monero chain.

Live on Monero mainnet; see the status in the [main README](../README.md).

A Mordinal that was inscribed in 2023 sits at a Monero output. Its holder can *claim* it with a signature (no coin
is spent) and from then on it moves by signed records. Every record is a short byte string
([`../RULES.md`](../RULES.md)). This folder holds the parts that put those records on the Monero chain and read them back:

| Part | File | What it does |
|---|---|---|
| Carrier framing | `lib/transport.mjs` | A record rides in `tx_extra` of an ordinary Monero transaction (RULES.md section 8). |
| Reader | `lib/reader.mjs` | Follows a Monero node block by block, finds records, judges each with the rule library, keeps an append-only log and periodic checkpoints. Handles restarts and chain reorganisations. |
| Follower | `lib/follow.mjs`, `lib/earlier.mjs` | Behind the reader, keeps the transactions of the earlier XMR20 formats in the blocks it has read (new token deploys, transfers of the GENESIS NFTs) in `xmr20-earlier/` inside the state folder, and goes back with it on a reorganisation. Changes nothing of the ledger; `--no-xmr20-follow` turns it off. |
| Relay | `lib/relay.mjs` | Takes a signed record over HTTP, checks it, and publishes it in a transaction it builds with its own small wallet. It holds no user key and cannot change a record. |
| Carrier tool | `carrier/` → `bin/mordinals-carrier` | The relay's wallet: builds and publishes the carrying transactions, splits coins. |
| Pictures | `lib/content.mjs` | Serves a Mordinal's inscribed bytes only after checking them against the hash in the owner list; only a short list of image types. |
| Service | `service.mjs` | The HTTP API below, for wallets and pages. Listens on 127.0.0.1. |
| Pages | `views/` | Explorer, gallery, market and "is it claimed?" pages, served at `/view/`. |
| Check tool | `tools/verify.mjs` | Checks a service without trusting it (replay, node lookups, full scan). |
| Checkpoint export | `tools/export-checkpoints.mjs` | Writes checkpoints as files for a public place. |

## What a wallet has to trust

- The **owner list** (`../ownership-index/result/owners.jsonl` plus `../ownership-index/added/added.jsonl`): which output holds which Mordinal. A wallet is
  built with the SHA-256 of the list (`ownersHash` in `lib/owners.mjs`), downloads the list in pieces from
  `/owners`, and compares. It downloads the *whole* list and looks for its own outputs itself, so the service never
  learns which unclaimed Mordinals a wallet holds.
- The **rules**: the same library (`../rules/lib`) runs in the reader, the check tool and the wallets.
- The **service's answers** are not trusted blindly: `tools/verify.mjs` replays the log with the rule library and
  recomputes every checkpoint; with `--node` it looks every record and payment up on a Monero node; with `--scan` it
  reads every block itself. Only `--scan` shows that the service left no record out.

## Running

```
node service.mjs --owners <owners.jsonl[,added.jsonl]> --domain <hex32> --fee-address <address> --node <url> --start <height> --state <dir>
     [--start-hash <hash>] [--mint-from <height> [--minters <address>,… [--open-from <height>]]] [--burn-from <height> [--burn-dead <index>,…] [--burn-fee-wallet <address>:<view key>]] [--network mainnet|stagenet] [--port 18951] [--every <ms>] [--transfers <transfers.jsonl>]
     [--collections <dir>] [--xmr20-inscribers <address>,…] [--xmr20-earlier <dir> | --no-xmr20-earlier] [--no-xmr20-follow]
     [--carrier-bin bin/mordinals-carrier --carrier-state <dir> --carrier-network offline-fakechain|stagenet|mainnet]
     [--content-dir <dir> | --content-archive [url]] [--views views] [--allow-origin <origin>] [--allow-extension <id>]
     [--behind-proxy] [--test-hooks]
```

`--allow-origin` and `--allow-extension` can be repeated; without `--allow-extension` any browser extension may
ask. `--behind-proxy` is for a service behind its own proxy on the same machine: the request limit then follows
the last address in `x-forwarded-for`; without it that header is ignored.

The settings of the live mainnet ledger are in [`../docs/LAUNCH-SETTINGS.md`](../docs/LAUNCH-SETTINGS.md), and the full
command is in the top README under "Run your own index".

Without `--carrier-bin` the service only reads. The carrier tool runs on the offline test chain, stagenet and mainnet;
on mainnet it also needs `MORDINALS_MAINNET=1` and an unrestricted node of its own. Build it with `sh carrier/build.sh`
(Rust toolchain).

## Claiming by burning (draft)

With `--burn-from <height>` the ledger claims Mordinals by burning from that block on (RULES.md section 10) and
refuses claim records 720 blocks later. On mainnet the dead outputs and the fee wallet are fixed; `--burn-dead` and
`--burn-fee-wallet` are for the offline test chain and other networks. Every owner list entry then has to state
`ownerOutputIndex`. The height can be corrected, or the option dropped, on a restart while the state folder has read
neither block; a new height has to be at least 10 blocks above the newest block the folder has read.

A burn claim is a paid service: it completes only once the fee payments for its Mordinal reach the burn
transaction's own fee. Each Mordinal's fee address is the fee wallet's subaddress at account 1, index = its number.
The fee wallet's secret view key is public, so the reader finds every fee payment itself: from the first burn block
on it looks at **every** transaction of every block with that key (one key derivation per transaction, one more for
each additional public key, and a lookup of the found key among the fee addresses of all Mordinals on the owner
list). A transaction that pays a fee address is journaled with what the rule reads of it (`fee` in its entry), after
the record or burn it carries; one that carries neither gets an entry of its own, `{height, pos, txid, ok: true, fee}`.
Until the fee is paid the Mordinal is burned and waits for it: not claimed, without an owner.

What this costs a reader, measured on 60 recent mainnet blocks (3,807,296 to 3,807,355; 1,975 transactions, 4,837
outputs) on an Apple M4 Pro with Node 24: the table of the 42,895 fee addresses takes about 3.1 s to build, once per
process; the scan then takes 1.4 ms per transaction, 48 ms per block on average (median 33 ms, at most 176 ms for a
block of 136 transactions). A reader that starts far behind spends that per block it catches up on, about 35 s per
day of blocks.

**Operator note.** The fee wallet sees and spends the fees only when its subaddress lookahead covers account 1 with
at least 50,000 addresses (`FEE_LOOKAHEAD` in `rules/lib/burn-fee.mjs`). In monero-wallet-rpc: `set_subaddress_lookahead`
with `major_idx` 2 and `minor_idx` 50000, then `rescan_blockchain` (`tests/lab-burn.test.mjs` does this with a view-only
copy and sees a payment at subaddress (1, 42894)); monero-wallet-cli has the same setting, `set subaddress-lookahead
2:50000` (not tried here). Creating account 1 and its addresses up to index 50,000 works too. A fee paid to a
subaddress the wallet does not watch stays invisible to it, though the ledger counts it.

What a burning ledger answers besides the usual:

| Route | What |
|---|---|
| `GET /info` | `burnFrom`, and `burn`: `recordsEnd` (the first block at which claim records are refused), `address`, `viewKey` (the burn address's public view secret), `text`, `dead`, `ownerOutputs` (the hash over every `number:ownerOutputIndex` line), `fee`: `wallet` (the fee wallet's main address), `viewKey` (its public secret view key), `account` (1), `safe` (what pages ask before a burn's own fee is known, 0.0012 XMR) |
| `GET /owners` | each entry also has `ownerOutputIndex`, so both owner-list hashes can be recomputed |
| `GET /mordinal/<n>` | `ownerOutput`, `burnFee: {address, paid}` (the Mordinal's fee address and what was counted for it), and while a burn waits `waiting: {txid, id, to, height, due, paid, missing}`; `waiting: true` also on cards (`/gallery`, `/address`) |
| `GET /burns?from=&limit=` | the valid burn claims and the fee payments in ledger order: `{height, pos, txid, before, id?, burn?, state?, fee?}`; `state` is where a burn claim stands now: `claimed`, `waiting` or `lost` (a claim record came first) |
| `GET /entry/<txid>` | for a burning transfer: `kind: "burn claim"`, accepted (with `number`, `to`, `state`, `claimedAt` and `fee: {due, paid, missing, address}`) or refused with the reason; for a transaction that pays fee addresses, `fees: [{index, number, amount, counted, error}]`, and `kind: "fee payment"` when it carries nothing else |
| `GET /status/<id>` | for a burn claim: `waiting` (with `fee`) until its fee is paid, `refused` when a claim record came first, then `done` |
| `GET /stats` | also `burns: {waiting, feePayments}`; `records` counts no entry that is a fee payment only |
| `GET /log` | every judged entry, records, burning transfers and fee payments, in chain order with block and place |

`GET /records` holds MD1 records only, as before. A burn claim is not a record: it is the transaction itself, and
`burn` in `/burns` holds the parts of it the rule reads; `fee` holds the parts a fee payment is read from. To replay
the ledger from the two lists, walk `/burns` in order: `before` is the number of entries of `/records` that come
before that entry (a record in the same transaction as a fee payment comes before it), so apply `records[0 … before)`,
then the burn claim (`applyBurnClaim`), then the fee payments (`applyBurnFees`), and after the last one the rest of
the records. `height` and `pos` (the transaction's place in its block) give the same order.

## Tests

```
node --test tests/reader.test.mjs    # offline, a few seconds: framing, reader, restart, reorg, relay limits, service, check tools
node --test tests/burn.test.mjs      # offline: claiming by burning and its fee (RULES.md section 10) in the reader and the service
node --test tests/lab.test.mjs       # local Monero test chain, real wallets, real carrier transactions (about a minute)
node --test tests/views.test.mjs     # the pages in a browser against the demonstration service (needs Playwright's Chromium)
```

Run `npm install` in the repository folder first. The lab needs `MONERO_BIN` (folder with `monerod` and
`monero-wallet-rpc`) and the built carrier tool. `lab-results.json` is the record of the last lab run.

## Trying it without a chain

```
node tests/demo.mjs [--port 18951] [--count 300] [--give <address>=7,120]... [--auto <ms>] [--allow-origin <origin>]
```

starts the service with a made-up Monero node, a made-up owner list of 300 entries, five made-up wallets and a few
listings, and serves the pages at `http://127.0.0.1:18951/view/`. `--give` puts numbered demo Mordinals at an address
of a throwaway wallet so that wallet can find and claim them. Nothing in the demonstration is real. Its extra
`/test/…` routes (make a block, make a payment, sign as a demo wallet) are listed at the top of `tests/demo.mjs`; the
real service has none of them.

## HTTP API

JSON everywhere. Errors are `{"error": "plain text"}` with a 4xx/5xx status. Amounts are strings of atomic units
(1 XMR = 10^12). `height` is the last block the reader has processed.

| Route | Answer |
|---|---|
| `GET /info` | `{network, domain, feeAddress, height, count, chunk, test, owners (list hash), start, startHash, relay: {networkFee:'relay', perAddress} or null, rules: {feeBps, marketFeeCapBps, minPrice, maxReserve, settle}}` |
| `GET /owners?from=&limit=` | `{from, total, entries:[{number, registrationTx, ownerTx, ownerOutputKey, ownerViewTag, ownerTxPubKeys, bodySha256?, bodySize?}]}`: the owner list in pieces of at most `chunk` |
| `GET /claimed` | `{height, numbers:[…]}`: every claimed Mordinal number |
| `GET /stats` | `{height, mordinals, claimed, forSale, sales, volume, fees, records, refused, byKind, checkpoint}` |
| `GET /gallery?filter=all\|claimed\|unclaimed\|listed&from=&limit=` | `{height, filter, from, total, items:[card]}`; card = `{number, reg, claimed, owner, bodySize, lot: {id, price, until, seller, reserved} or null}` |
| `GET /mordinal/<number or registration txid>` | `{height, mordinal:{number, reg, claimed, owner, seq, lot, registrationHeight, ownerTx, ownerHeight, bodySize, bodySha256}, history:[event], waiting:[job]}`. History starts with `{kind:'inscribed', height, txid}`, then the 2023 moves `{kind:'transfer', height, txid}`, then record events. This is the public "is it claimed?" answer. |
| `GET /address/<address>` | `{height, mordinals:[state], buying:[lot], waiting:[job]}`; state = `{number, reg, claimed, owner, seq, lot}` |
| `GET /listings` | `{height, listings:[lot]}` (open and not expired) |
| `GET /lot/<id>` | `{height, lot, waiting:[job]}`; lot = `{id, number, reg, seller, price, until, status:'open'\|'sold'\|'cancelled', body (hex of the list record), reservation:{record, buyer, height, payBy, rate} or null, buyer}`. A reservation holds the listing until block `payBy + settle`. |
| `GET /activity?kind=&number=&address=&before=&limit=` | `{height, total, next, events:[event]}` newest first; pass `next` as `before` for the next page |
| `GET /sales?…` | the same, sales only |
| `GET /status/<record id>` | `{height, id, state, txid, height, confirmations, error, note}`; state is `queued`, `held`, `built`, `sent`, `done`, `refused`, `stuck` or `unknown` |
| `GET /tx/<txid>` | `{height, payment:{txid, height (null while in the pool), tx}}`: a Monero transaction as the node gives it, cut to the parts the rules read. A buyer's wallet uses it to make the payment proofs of a purchase. `404` while the node does not know it; counts toward the request limit. |
| `GET /pending` | `{height, jobs:[job], pool:[{txid, record, op, id}]}`: records waiting for a block |
| `GET /log?from=&limit=` | `{height, hash, from, total, entries:[{height, pos, txid, record, id?, ok, error?, facts?}]}`: the full record log, accepted and refused |
| `GET /nfts?from=&limit=&collection=` | `{height, total, from, items:[nft]}`: minted NFTs, newest first; nft = `{id, collection, edition, creator, name, type, size, sha256, origin?, collectionName, owner, burned, seq, height, txid, lot}` |
| `GET /nft/<id>` | `{height, nft, record (the mint record), collectionRecord, history:[event], waiting:[job]}` |
| `GET /nft/<id>/content` | the inscribed bytes when they are a picture (by their first bytes) or plain text; `415` otherwise |
| `GET /nft-collections`, `GET /nft-collection/<id>` | collections made on the ledger; one with its record and its minted NFTs |
| `GET /entry/<transaction id>` | what became of the record a transaction carried: accepted or refused, with the reason, its block and confirmations |
| `GET /collections`, `GET /collections/<key>`, `GET /collections/<key>/<edition>`, `…/picture` | the saved XMR20 NFT collections (GENESIS): the collection with its NFTs, one NFT with its moves, and its picture drawn as its own text over its picture (`?plain=1` for the bare picture). Owners are those at the block in `ownersAsOf`; see [`../xmr20-nfts/`](../xmr20-nfts) |
| `GET /xmr20/tokens`, `GET /xmr20/token/<id>`, `GET /xmr20/deploys/<mint>` | XMR20 tokens inscribed on this ledger ([`../xmr20-tokens/FORMAT.md`](../xmr20-tokens/FORMAT.md)) |
| `GET /xmr20/earlier`, `GET /xmr20/earlier/<transaction id, mint or number>` | XMR20 tokens of the earlier deploy inscriptions, read on in the blocks this reader follows ([`../xmr20-tokens/EARLIER.md`](../xmr20-tokens/EARLIER.md)) |
| `GET /checkpoints` | `{height, checkpoints:[{schema, network, domain, owners, start, height, blockHash, records, listHash, stateHash}]}` |
| `GET /checkpoint` | the same summary at the current block |
| `GET /records?from=&limit=` | `{height, total, from, records:[hex]}`: accepted records in order, 1,000 at a time unless `limit` says otherwise (at most 5,000) |
| `GET /content/<number>` | the inscribed bytes when they are one of the allowed picture types and match the owner list's hash; headers `x-mordinal-sensitive`, `x-mordinal-sha256`. An SVG document that names nothing outside itself is answered with a PNG picture the service draws from it (at most 1,024 pixels a side; `x-mordinal-drawn: svg`, kept by caches for a day; `lib/draw.mjs`); the SVG itself is never served. `415` when it is not a picture, `404` when unknown. |
| `GET /text/<number>` | the inscribed bytes as `text/plain; charset=utf-8` when they are a short plain text (at most 4,096 bytes of UTF-8 with something that shows and no control, format or hidden character but tab, line feed, carriage return and the zero-width joiners; `lib/content.mjs` `plainText`) and match the owner list's hash, for a page to show as text; the same headers as `/content/`. `415` for a picture or other content, `404` when the number is unknown or the content is not known |
| `POST /records {record: hex}` | needs `content-type: application/json` (`415` otherwise). Hands a signed record to the relay → `{height, id, state, op, number, txid, error, note}`. `400` rule refusal, `429` limits, `503` relay cannot work now. Posting the same record again returns the same job. |
| `GET /view/…` | the pages |
| `POST /test/step` | only with `--test-hooks`: one reader and relay pass now |

Events: every event has `{height, pos, txid, id, time, kind, number, confirmations}` plus

- `claim`: `to`, `proof` (`'one-time key'` or `'payment proof and message'`)
- `move`: `from`, `to`
- `list`: `lot`, `seller`, `price`, `until`
- `cancel`: `lot`, `seller`
- `reserve`: `lot`, `buyer`, `payBy`
- `sale`: `lot`, `seller`, `buyer`, `price`, `fee`, `payments:[txid]`

Jobs: `{id, state, op, number, txid, error, note}`.

### What happens to a record sent to the relay

1. `queued`: accepted; no transaction yet (no coin ready, or the node was unreachable).
2. `held`: a purchase whose payment is not in a block yet. It is sent once the payment is.
3. `sent`: its transaction is in the node's pool.
4. `done`: the reader found it in a block and the rules accepted it. Until then nothing has changed.
5. `refused`: it reached a block (or was about to) and the rules refuse it; `error` says why.
6. `stuck`: it did not reach a block for a long time. The record can be sent again.

A record counts only when it is in a block. Blocks can be replaced for a short while; the relay then sends the same
transaction again.

Replaced blocks can also put a purchase record before its own payment, and the record is then refused in its block.
The relay sends such a purchase again in a new transaction when the rules would accept it now, or holds it until
its payment is in a block. It does this at most twice per record (`sendAgain`); after that, or when the rules
refuse the purchase for another reason, the record is `refused`.

A payment named by a purchase is checked against the reader's own journal: the block at the payment's height has
to have the hash the journal holds and has to list the payment. If the node answered from blocks that were
replaced, the block is read again.

### Limits the relay applies

Three waiting records per signing address, one waiting record per Mordinal, a total and a daily cap, and a request
rate per network address. The relay's wallet pays the Monero network fee of each carrying transaction (measured
size: about 2 kB for a claim with a payment proof). It can charge for collection and mint records
(`--mint-fee`, `--collection-fee`); the project's relay charges nothing at present.

## Known limits

- The carrier tool marks a coin as used when it builds a transaction; if that transaction is never published the
  coin stays unused until the tool's state is rebuilt.
- Checkpoints are statements of whoever runs the reader. They are not signed and not anchored on chain.
- A reservation costs the buyer nothing, so a listing can be held by repeated reservations (30 blocks to pay plus
  10 blocks to record the purchase, each).
- A reservation holds its listing for 10 blocks after its pay-by block, so a purchase paid in time can still be
  recorded. A purchase paid after the pay-by block counts only if nobody has reserved the listing since (RULES.md
  section 5). If someone has, the late payment is a plain transfer to the seller and buys nothing. Wallets and the
  market page therefore refuse to pay late.
- Reading requests are not limited by the service itself; a proxy in front has to do that.
- The state folder format is `mordinals-reader-v3` (buy records carry payment proofs, not transaction keys). A folder written in an earlier format is refused; start a
  new one.
- [`../docs/OPEN-POINTS.md`](../docs/OPEN-POINTS.md) lists what a reviewer should look at first and what is still open.
