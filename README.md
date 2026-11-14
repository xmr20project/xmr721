# XMR721

**XMR721** is an NFT standard for Monero. An NFT is owned by an ordinary Monero address and
is sent and sold with a wallet signature. No coin is spent to move it, so nothing about
anyone's Monero spending is made public.

Its first collection is **Mordinals**, the 2023 inscriptions on Monero. This repository holds
the full ownership index of all of them, the rules, and the reader and relay that run the
standard. With it a Mordinal can be claimed, sent and sold without spending the coin it was
inscribed on, and new NFTs and XMR20 tokens are inscribed on the same ledger.

The name follows the XMR20 token standard, the same way NFT standards on other chains
follow their token standards.

> **Live on Monero mainnet.** The ledger starts at block 3,804,029. Mordinals are claimed,
> sent and sold on it, and from block 3,805,946 NFTs and XMR20 tokens are inscribed on it by
> the ledger's listed minters. See [Status](#status) and [Run your own index](#run-your-own-index).

![Gallery page of the reader, demonstration data](docs/img/gallery.png)

## What Mordinals were

In March 2023 a modified Monero node and wallet ([mooonero/mordinals](https://github.com/mooonero/mordinals))
let people inscribe pictures and other files into Monero transactions. An inscription sat in
the transaction's extra data, and whoever held the first output of that transaction owned
the Mordinal. 42,894 were made.

Two things went wrong.

**Moving one broke Monero's privacy.** To transfer a Mordinal the owner had to spend the
inscribed coin in a ring whose other members were 16 fixed, unspendable keys. That showed
everyone exactly which coin was spent. A coin known to be spent hides nothing when another
wallet later picks it as a decoy (a "black marble"), so every transfer made other people's
transactions a little easier to trace. The Monero community objected, and nodes soon stopped
relaying transactions with large extra data.

**Then the tooling disappeared.** The explorers and marketplaces that showed and traded
Mordinals shut down or were abandoned. The original software was not kept up with the
network. Nobody published an index of which Mordinals exist and who holds them.

What the chain says today (read to block 3,802,870, 9 November 2026):

| | |
|---|---|
| Mordinals | 42,894 |
| Transfers ever made under the original rules | 164, moving 139 Mordinals |
| Of those, in April 2023 | 120 |
| Last transfer | 22 December 2023 |
| Mordinals still on the coin they were inscribed on | 42,755 |

The Mordinals are all still there. For almost three years nothing could be done with them.

## What XMR721 does

**1. A full ownership index.** [`ownership-index/`](ownership-index) holds the owner of every
Mordinal under the original rules, worked out from the chain by running the original index
code unchanged and a second, separately written replay next to it. The two agree on all
42,894 Mordinals and every transfer. As far as we know this is the only complete, public
index of Mordinals and their owners.

**2. Rules for owning them without spending them.** [`RULES.md`](RULES.md), the XMR721
rules:

- At a start block the owner list is fixed. Every Mordinal keeps its number and its history.
- The holder **claims** a Mordinal once, to an ordinary Monero address, with a signature made
  by the key of the inscribed coin. The coin is not spent and stays an ordinary coin.
- After that it **moves** by a message signed in a Monero wallet ("sign message" in Feather,
  Cake Wallet, the Monero command-line wallet or the XMR20 wallet). No ring is touched.
- It can be **sold** for XMR. The seller signs a listing, the buyer reserves it and pays with
  a normal Monero transaction, and a proof of that payment completes the sale. Of each sale
  95% goes to the seller and 5% to a protocol fee address.
- Every record is a short byte string carried in an ordinary Monero transaction, so the
  ledger can be rebuilt by anyone from the chain and the owner list alone.

**3. The software to run it.** [`rules/`](rules) is the rule library, [`reader/`](reader)
follows the chain and keeps the ledger, serves it to wallets and pages, and includes a relay
that carries signed records for wallets that cannot build such a transaction themselves.
The relay cannot change a record. A check tool replays a reader's log without trusting it.

## The largest inscription on Monero

On 5 November 2026 the XMR20 project mined block 3,799,494 with a 598,000-byte video
inscribed in its mining reward transaction. It is the largest block in Monero's history
(weight 599,000; the previous record was 569,375 at block 2,274,242 in January 2021) and
holds the largest transaction and extra data we know of. The largest inscription made under
the original Mordinals rules is 141,345 bytes (#264).

The original rules only read ordinary transactions, so by those rules the video is not a
Mordinal. XMR721 adds it as one extra entry, number 42,894, after the original 42,894
(numbers 0 to 42,893). The entry and the tool that builds and checks it from any Monero node
are in [`ownership-index/added/`](ownership-index/added). The reader's pages do not play
video yet.

## XMR20 NFTs: the GENESIS collection

In October 2026 the XMR20 project inscribed GENESIS on Monero: 100 small renderings of
well-known paintings, each one complete in a single transaction. They were made before
XMR721, in an earlier format of their own, and are owned by Monero addresses from the
start, so no coin is ever exposed.
[`xmr20-nfts/`](xmr20-nfts) holds the collection as rebuilt from the chain, the
[format](xmr20-nfts/FORMAT.md) and the code that decodes and checks it. A reader serves it
with every picture drawn as it is meant to be seen, its text over its picture, and keeps
its owners current from the transfers in the blocks it follows. That format is legacy; new
inscriptions are planned to use XMR721.

## Layout

| Path | What |
|---|---|
| [`RULES.md`](RULES.md) | The XMR721 rules (draft 4): records, checks, fee rule, privacy rules, new NFTs |
| [`rules/`](rules) | The rule library, its offline tests, and tests against real wallet software on a local test chain |
| [`reader/`](reader) | Reader, relay, HTTP service, explorer/gallery/market pages, check tools |
| [`ownership-index/`](ownership-index) | The owner list, how it was made and checked, and the added entry |
| [`xmr20-nfts/`](xmr20-nfts) | The GENESIS collection of XMR20 NFTs, their earlier format and decoder |
| [`xmr20-tokens/`](xmr20-tokens) | XMR20 tokens as inscriptions on this ledger: the [deploy text](xmr20-tokens/FORMAT.md), the token list a reader serves, and the launch inscriber; and the [earlier XMR20 deploy inscriptions](xmr20-tokens/EARLIER.md) from before this ledger, as a checked list every reader serves |
| [`docs/LAUNCH-SETTINGS.md`](docs/LAUNCH-SETTINGS.md) | The settings of the live ledger: start block, domain, fee address, first mint block, minters |
| [`docs/OPEN-POINTS.md`](docs/OPEN-POINTS.md) | What review has changed so far and what is still open |

## Run your own index

Anyone can run the reader against their own Monero node and get the same ledger as every
other reader with the same settings: the same records, the same owners, the same
checkpoints. Nothing has to be trusted but the node, and the node can be your own.

Node.js 22 or newer and a synchronized Monero node (`monerod`).

```
npm install
node reader/service.mjs --network mainnet --node http://127.0.0.1:18081 --state xmr721-state \
  --owners ownership-index/result/owners.jsonl,ownership-index/added/added.jsonl \
  --transfers ownership-index/result/transfers.jsonl \
  --domain ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d \
  --fee-address 45J4QMTbVoi61ZQoUzLVh7VkvjuRbqaaHW1AophY1Jbi9KzTzk8qoh43fT6JWYvkk6j6X1Stog7Xb9ZabzBrMr7tGzANudW \
  --start 3804029 --start-hash cddee72e248e6fc903d7850f73e29cceff64dd9a027f64afc7362d76784081cd \
  --mint-from 3805946 \
  --minters 42zfMRhM9aQAXb4uZKw5gzVN9uTf3bUrgAz2cY7jpvbn8ZE4RWsBsKUECgXNiFKsqK9nBDPThFzTafsZX3bZ7socRQZU1qX,47hW3YWbqR5LrvJyfRSBAqArp8TcU1xnL29dn5xpEWJN9dmyohzaS4ug3e57yvSGmT3UWh47gfN4VW1soHSrXsmqD8haurE \
  --xmr20-inscribers 42zfMRhM9aQAXb4uZKw5gzVN9uTf3bUrgAz2cY7jpvbn8ZE4RWsBsKUECgXNiFKsqK9nBDPThFzTafsZX3bZ7socRQZU1qX \
  --collections xmr20-nfts/collections
```

It reads every block from the start block on and serves the ledger at
`http://127.0.0.1:18951` (`/info`, `/owners`, `/nfts`, `/xmr20/tokens`, `/collections/genesis`
and the rest in [`reader/README.md`](reader/README.md)). `/info` gives the latest checkpoint;
two readers with the same settings at the same block give the same one.
`node reader/tools/verify.mjs` replays a reader's log and checks it without trusting the reader.
The settings are explained in [`docs/LAUNCH-SETTINGS.md`](docs/LAUNCH-SETTINGS.md).

The XMR20 project runs one such reader at `https://api.xmr20.org/xmr721/`.

## Inscribe

The `xmr721` command is a Monero wallet of its own that inscribes on the ledger: a file
becomes an NFT, owned by the wallet or by any Monero address you name. The wallet pays the
network fee of each transaction; there is no other fee.

Minting is open to everyone from the ledger's opening block on (see [Status](#status)).
Before that block the command says when it is, and sends nothing.

You need macOS or Linux, Node.js 22 or newer, a synchronized Monero node of your own
(`monerod`, unrestricted: the wallet takes its decoys from it), and Rust once, to build the
wallet's transaction tool. The command works on Monero mainnet unless told otherwise.

```
npm install
sh reader/carrier/build.sh                      # builds reader/bin/mordinals-carrier
node cli/xmr721.mjs wallet create               # prints the wallet's address
node cli/xmr721.mjs wallet inscribe --file moon.png --name "Moon" --to <your Monero address> --dry-run
```

The dry run says whether minting is open to you and what would be inscribed. Then pay the
wallet (0.05 XMR is plenty to begin with; a coin can pay 10 blocks after it arrived) and
inscribe:

```
node cli/xmr721.mjs wallet balance
node cli/xmr721.mjs wallet inscribe --file moon.png --name "Moon" --to <your Monero address>
node cli/xmr721.mjs wallet inscriptions
```

- **One transaction, one NFT.** A record is at most 1,000 bytes: up to 824 bytes of content,
  759 with `--to`, less by the length of the name. `--type` names the content type when the
  file ending does not (png, jpeg, webp, gif, text, json, mp4, art). `--dry-run` shows the
  record's id and the text it would sign, and builds and sends nothing.
- **A record counts once.** The same file with the same name by the same wallet is the same
  record. Asked for it again, the command sends its transaction again or says where it is,
  and does not pay for it twice. In a collection the same holds while the edition's
  transaction is on its way; once that edition is final, the same file is the next edition.
- **Collections.** `wallet collection --name <name> --max <n>` makes one. Once it is in a
  block, `wallet inscribe --file … --collection <id>` mints its next edition. Only the wallet
  that made a collection mints its editions.
- **Owning and moving.** With `--to` the NFT belongs to that address from the start, so a
  normal wallet (Feather, Cake Wallet, the XMR20 wallet) can send and sell it by signing a
  message. An NFT the `xmr721` wallet owns itself is sent with
  `wallet send <nft id> <address>`.
- **What is public.** The wallet's own address is written into every record as its creator,
  and the `--to` address as the owner. Both are public for good.
- **Coins.** Each record rides on one coin of the wallet, and the balance shows that coin as
  gone until its change is in a block. `wallet split <n>` makes n coins of 0.01 XMR from one
  larger coin, so that n records can go out in one block; it needs one coin a little larger
  than n × 0.01 XMR (0.06 XMR in one payment splits into five). After a long pause the
  wallet reads every block since it was last used, which takes a while.
- **Nothing is lost when something fails.** Every transaction the wallet builds is written
  down and kept until what it carried is final on the ledger, 10 blocks deep.
  `wallet inscriptions` says where each one is: waiting for a block, on the ledger, refused
  by the ledger and why, or no longer with the node. `wallet resend` sends again, as the
  same transactions, what the node does not have. One command at a time works on a wallet
  folder.
- **A transaction that was sent cannot be taken back.** Once nodes have it, it gets into a
  block or they drop it after about three days. `wallet forget <n>` removes a transaction
  that never reached the node, and what it held is free at once. For one that was sent,
  `wallet forget <n> --sent` only stops the wallet from sending it again: it can still get
  into a block, so its edition or its NFT is not given to anything else by itself until
  nodes have dropped it. Check an address before you send to it.
- **Stopping the command.** Ctrl-C stops it at once, unless a transaction is being built or
  handed to the node at that moment: then that one step is finished and written down, and
  the command stops after it.
- **Coins that seem lost.** The tool marks a coin as used when it builds a transaction. If
  that transaction never gets into a block, `wallet rescan` reads the coins anew and the
  coin is back. It runs when nothing of the wallet is on its way any more.
- **The wallet folder** (`~/.xmr721/wallet`, or `--wallet <dir>`) holds the keys. Back it up.
  The command cannot send XMR out: to move what is left, restore a wallet from keys in the
  Monero command-line wallet (`--generate-from-keys`) with the address `wallet receive` shows,
  the two keys in `carrier.keys.json`, and the `start` block in `wallet.json` as its restore
  height.
- **Which reader.** Before it makes a record the command asks a reader for the ledger's
  state: by default `https://api.xmr20.org/xmr721`, or your own with
  `--reader http://127.0.0.1:18951`. On mainnet the command inscribes on the one ledger
  above whatever a reader claims, and it signs what you asked for. Two numbers in a record
  come from the reader, though: the next free edition and an NFT's move number. A reader that
  lies about them makes the wallet pay for a record the ledger refuses, and such a record
  could count later, when the number comes true. A reader also sees which transactions you
  ask it about. Your own reader avoids all of it.
- **Stagenet.** `--network stagenet` with `--reader`, `--domain` and `--node` of a stagenet
  ledger of your own.

`node cli/xmr721.mjs --help` lists every command and option.

## Try it

Node.js 22 or newer.

```
npm install
npm test          # rule library, reader and NFT decoder, offline, a few seconds
npm run demo      # explorer, gallery and market at http://127.0.0.1:18951/view/ with made-up data
```

The demonstration uses a made-up chain, owner list and wallets; nothing in it is real.
`npm run test:views` drives the pages in a browser (run `npx playwright install chromium`
once). `npm run test:lab` runs the rules and the relay against `monerod` and
`monero-wallet-rpc` on an offline test chain: set `MONERO_BIN` to the folder that holds
them and build the relay's wallet first with `sh reader/carrier/build.sh`.

## Status

- **Live on mainnet.** The ledger starts at block 3,804,029: claims, moves, listings and
  purchases of Mordinals. From block 3,805,946 NFTs and XMR20 tokens are minted on it.
- **Minting is limited for now.** The ledger's setup lists two minters, the XMR20 launchpad's
  inscriber and the Sweep and Burn issuer. Moving, selling and burning are open to every
  owner. Opening minting to everyone from a later block is the next step.
- **Reviewed in rounds, not audited.** Each step had review rounds before it went live;
  [`docs/OPEN-POINTS.md`](docs/OPEN-POINTS.md) lists what they changed and what is still open.
- **The relay** carries signed records for wallets that cannot build such a transaction
  themselves and pays the network fee. It cannot change a record.
- **Wallets.** Claim, send and sell screens are in the XMR20 wallets and on
  [xmr20.org](https://xmr20.org/); any Monero wallet that can sign a message (Feather, Cake
  Wallet, the command-line wallet) can sign the records.
- **Earlier XMR20 formats.** The GENESIS NFTs and the XMR20 tokens deployed before this
  ledger are read in their own formats and kept current by every mainnet reader
  ([`xmr20-nfts/`](xmr20-nfts), [`xmr20-tokens/EARLIER.md`](xmr20-tokens/EARLIER.md)).
- **Anyone can run a competing index.** Ownership here rests on people agreeing to these
  rules. That is why the index, the rules and the reader are public and reproducible.

## Credit

Mordinals were created in 2023 by the authors of
[mooonero/mordinals](https://github.com/mooonero/mordinals). The inscriptions are theirs and
their holders'; XMR721 does not change them, and the name Mordinals stays with them. The ownership index runs the original
index code from that repository, unmodified, at commit `8467001`.

Maintained by the [XMR20](https://xmr20.org/) project. MIT licence.
