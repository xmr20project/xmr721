# Mordinals ownership index

Works out who owns every original Mordinal under the original rules
(mooonero/mordinals @8467001ca681f9f367b90973932ef1c0335d42b6), by reading the Monero chain.
Read-only. It changes nothing on any server and touches no wallet.

Run on 9 November 2026 up to block 3,802,870
(`f118f7cb1ace1f8bd53b5be0af4fc8289bcff1566573c850e56e695ca7f3f5a9`, 21:20 UTC).

## Result

| | |
| --- | --- |
| Blocks read | 964,601 (2,838,270 to 3,802,870) |
| Transactions read | 36,784,891 |
| Mordinals | 42,894 |
| Registrations ignored by the original rules | 209 (161 repeat an earlier body, 48 paid below the fee rule) |
| Old-style transfers applied | 164 |
| Old-style transfers ignored | 1 (the spent coin was not an owner coin) |
| Mordinals that ever moved | 139 (119 once, 15 twice, 5 three times) |
| Mordinals still on their first owner coin | 42,755 |
| Last old-style transfer | block 3,045,217, 22 December 2023 |
| Old-style transfers since then | 0 |

Applied transfers by month: March 2023 6, April 2023 120, May 2023 3, June 2023 4,
July 2023 2, December 2023 29.

The original index never reached its stop state (the flag it sets when a registration lands
on an output that is already an owner coin).

## Added entry

`added/added.jsonl` holds entries this ledger adds after the original 42,894. There is one:
number 42,894, the 598,000-byte video in the mining reward transaction of block 3,799,494
(`5aaa33278d1c4f318ffc8512ea5466440a6023f7087998b31ad011ed42920f9b`, 5 November 2026). The
original rules read only ordinary transactions and the `0x10` field, so it is not a Mordinal
under those rules and is not in `result/`. Its owner coin is the single output of that
transaction.

```
node added/video-entry.mjs --node <monero node url> [--save-video video.mp4]
```

reads the transaction from any Monero node, checks its id, block, payload format and the
video's size and SHA-256, and prints the entry. Hash of the owner list with this entry, as
wallets and readers compute it (`ownersHash` in `reader/lib/owners.mjs`):
`e71d340d84538c229f9e190d221271873cde6b1daab8366d9b282ff016e639ee`.

## Files in `result/`

- `owners.jsonl` — one line per Mordinal, in inscription order: number, registration
  transaction and block, body hashes and size, number of moves, and the current owner coin
  (transaction, block, global output index, output key, view tag, transaction public keys).
  SHA-256 `2170e7e3db05923bca1b879e7f19916fb29979204896d2fcc96991215455a299`.
- `transfers.jsonl` — every transaction carrying a `0x11` field, with the outcome.
- `ignored-registrations.jsonl` — every `0x10` transaction that did not create a Mordinal,
  with the reason.
- `summary.json` — the counts above.
- `checks.json` — the cross-checks below and the block time of every transfer.

## How it was made

1. `scan-remote.py` reads the node's block database directly (read-only, no lock, low
   priority) and returns every non-coinbase transaction whose extra data reaches a `0x10`
   or `0x11` field, with its global output indexes. `run-scan.sh` runs it in five height
   ranges at once.
2. `native/replay` feeds those transactions, in chain order, to the original index code.
   `inscriptions_container.cpp` and `cryptonote_format_utils.cpp` are compiled unchanged;
   `native/build.py` checks their hashes against `native/source-manifest.json` first and
   writes `native/build-evidence.json`.
3. `check.py` is a second replay written separately in Python, with its own transaction and
   extra-field parser. It compares every decision and every owner with step 2 and stops on
   any difference. Then it writes the result files.

```
NODE_SSH=user@host ./run-scan.sh SCAN_DIR 3802870 5
MORDINALS_SOURCE=... MORDINALS_BUILD=... python3 native/build.py   # see its header
native/build/replay SCAN_DIR/native.jsonl SCAN_DIR/part-0.bin ... SCAN_DIR/part-4.bin
python3 -I check.py SCAN_DIR/native.jsonl OUT_DIR SCAN_DIR/part-0.bin ... SCAN_DIR/part-4.bin
```

The scan output (about 320 MB) is not kept. Re-running the scan reproduces it.

## Checks

- Original code and the separate replay: 43,268 candidate transactions, 42,894 Mordinals,
  0 differences.
- Existing registration catalogue (43,103 rows): all 42,894 Mordinals match on transaction,
  block, body SHA-256, body Keccak-256 and size. The other 209 rows are exactly the 209
  ignored registrations. The scan found nothing the catalogue lacks.
- Node (monerod 0.18.5.3): all 165 transfer transactions exist at the stated block with the
  stated first output index. The last scanned block hash matches.

## Limits

- The list says which coin holds each Mordinal. It cannot say whether the holder has since
  spent that coin in an ordinary transaction; Monero hides that. Under the original rules
  the Mordinal stays with the coin either way.
- Only transfers that carry the `0x11` field are counted. That is what the original index
  follows.
- The second replay identifies bodies by SHA-256. Transaction ids and Keccak-256 hashes come
  from the original code and were confirmed against the catalogue and the node.
- The 16 dead ring keys are taken from the original source by their output indexes.
- The list ends at block 3,802,870. A later registration or transfer needs a new run.
