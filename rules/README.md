# Rule library

The rules of [`../RULES.md`](../RULES.md) as code. The reader, the check tool, the pages and
the wallets all import this one library, so they cannot disagree about a record.

What it covers: a Mordinal is claimed without spending its owner coin (two kinds of proof),
then moved and sold by signed records, with 5% of every sale going to a fee address.

## Layout

| Path | What |
| --- | --- |
| `lib/records.mjs` | Record format, texts to sign, amounts |
| `lib/claim.mjs` | One-time-key signature, payment-proof check, "find my Mordinals", payment proof from the view key |
| `lib/ledger.mjs` | The rules: owners, listings, reservations, sales |
| `lib/monero.mjs`, `lib/payment.mjs` | Addresses, wallet message signatures, payment check, payment proofs for buy records |
| `tests/rules.test.mjs` | Offline tests with made-up keys, plus a replay of the saved lab cases |
| `tests/lab.test.mjs` | The same rules against real wallet software on a local test chain |
| `tests/fixtures.json` | 49 saved cases from the lab (22 accepted, 27 refused) with the expected result. Public data only |
| `lab-results.json` | Summary of the last lab run |
| `tests/lab-wallet-apps.test.mjs` | The claim for Feather and Cake holders against real wallet software |
| `tests/fixtures-wallet-apps.json`, `lab-wallet-apps-results.json` | Its 7 saved cases and summary |
| `tests/lab-harness.mjs` | Test chain and wallets shared by the two labs |
| `tools/find-mine-timing.mjs` | Times the owner-list search over the real 42,894 entries |

## Run

```
node --test tests/rules.test.mjs     # offline, a few seconds
node --test tests/lab.test.mjs       # about 40 seconds; rewrites tests/fixtures.json and lab-results.json
node --test tests/lab-wallet-apps.test.mjs   # about 25 seconds; rewrites its own fixtures and results
node tools/find-mine-timing.mjs       # needs ../ownership-index/result/owners.jsonl
```

Run `npm install` in the repository folder first. The labs need `monerod` and
`monero-wallet-rpc` 0.18.x: set `MONERO_BIN` to the folder that holds them. A lab starts its
own offline chain and five throwaway wallets in a `runs-lab-*` folder and deletes the folder
when it passes.

## Results

Last full run: 10 November 2026. Offline tests: 23 of 23. Wallet lab: 22 records accepted and
27 refused, as expected. Feather and Cake claim lab: 6 accepted and 1 refused, as expected.

What the lab ran with real wallet software (wallet2, the wallet code inside Feather, Cake
Wallet and the Monero command-line wallet):

- **Claim by payment proof and signed message.** The wallet makes an `InProofV2` for a
  transaction it sent to itself, for a subaddress, and for change at output 0. This
  verifier and the wallet's own `check_tx_proof` agree in both directions. Refused: a proof
  made with a message, a proof of another transaction, an OutProof, a view-key signature, a
  signature by another wallet, and an address paid by output 1 of the transaction.
- **Claim by one-time key.** The wallet's keys find its two test Mordinals in the owner
  list, and the signature under the owner coin's key is accepted, for a main-address coin
  and a subaddress coin. The same signature placed on a claim to another address is refused.
- **Sale, one transaction.** The buyer pays seller and fee address in one transaction with
  two destinations and one transaction key. Seller received 95% and the fee address 5%
  (plus the reservation's last digits). The wallet's own `check_tx_key` reports the same
  amounts. The buy record is 296 bytes and holds no transaction key: it carries one proof
  per payee. The wallet's own `check_tx_proof` accepts each proof in the record, and a
  proof the wallet makes with `get_tx_proof` is accepted by this check.
- **Sale with a marketplace fee** of 2.5% on top, paid in two transactions, seller on a
  subaddress. The buy record is 425 bytes.
- **Sale to a subaddress seller in one transaction**: the wallet uses four transaction
  keys; the buy record is 296 bytes and its proof is made with the key of the seller's
  output.
- **Refused**: missing fee, round amounts without the last digits, proofs made with another key or for another
  listing, a record that leaves a payee out, a
  payment used twice, a late payment after someone else reserved, a second reservation, a
  reservation right after another ran out (the listing is held 10 blocks longer), a
  marketplace fee above the cap, selling or moving while listed, a record signed before a
  cancel, a former owner's move.

- **Locked payment.** The wallet software refuses to make a payment with a lock time, so
  that case is only in the offline tests, together with an amount split over two outputs,
  a payment whose public key in the transaction is not the one the transaction key gives,
  and one output counted for two sales.

Largest records: buy 425 bytes, claim 361, reserve 238, move 236, list 183, cancel 167.
The Monero limit for `tx_extra` is 1,060.

"Find my Mordinals" over the real owner list (42,894 entries): 53 seconds in plain
JavaScript on a laptop. A wallet should do this step in compiled code or show progress.

## What was learned about the wallet apps

From the apps' source code. The apps themselves were not driven.

| | Sign message | Payment proof (InProof) | Pay two addresses at once | Show transaction key |
| --- | --- | --- | --- | --- |
| Monero CLI / wallet RPC | yes | yes, also for a transaction sent to itself (run in the lab) | yes | yes |
| Feather | yes | **only for received transactions** | yes ("pay to many") | yes |
| Cake Wallet | yes | no | yes | yes |

- **Feather refuses an InProof for an outgoing transaction** ("Can't create InProofs for
  outgoing transactions."). 42,755 of 42,894 Mordinals still sit on the coin made by the
  inscription itself. Where the holder inscribed from the same wallet, that transaction is
  outgoing there, and Feather's screens cannot make the proof (the chain cannot show how
  many holders that is). They can claim with a wallet that signs with the one-time key or with the
  Monero command-line wallet (`get_tx_proof <txid> <own address>`). A holder who was sent a
  Mordinal can use Feather. Two more ways are in the next section.
- **Cake Wallet** has no payment proof.
- **Payment proofs show more than the address.** The proof holds the shared secret of the
  owner transaction, so anyone can also read the amount of the owner coin. The one-time-key
  claim shows neither.

## Claiming from Feather and Cake Wallet

A signed message alone cannot tie an address to the owner coin; that link needs the private
view key. Two ways to supply it were run in `tests/lab-wallet-apps.test.mjs` with the wallet
code both apps are built on. Both give the ordinary proof 1 claim record (361 bytes). The
rules did not change.

1. **View key in a local tool (Cake, Feather).** `findWithViewKey` takes the wallet's main
   address and private view key, finds the wallet's Mordinals in the owner list (main
   address and first subaddresses) and makes the payment proof for each
   (`inProofFromViewKey`). The holder signs the claim text in the wallet. In the lab the
   wallet's own `check_tx_proof` accepted all four proofs made this way, including a
   self-sent transaction and subaddress coins.
2. **View-only copy of the wallet (Feather, no key leaves the app).** The full wallet lists
   a transaction it sent to itself as `out`; a view-only wallet made from the same address
   and view key lists it as `in` and makes the `InProofV2` itself. The holder signs the
   claim text in the full wallet.

Refused: a signature made with the view key, a signature from the view-only wallet,
a signature by another wallet, the main address signing for a subaddress coin, and a correct
proof for a Mordinal held by another wallet. A wrong view key is reported before anything is
made.

What the holder gives up compared with the one-time-key claim: the claim record shows the
holding address and lets anyone read the owner coin's amount (as proof 1 always does). The
view key itself is never part of a record. A tool that asks for it must run locally and
send nothing.

Not done: the steps were not walked through in the Feather and Cake apps (where the view
key is shown, making the view-only copy, signing with a subaddress).

## Limits

- The test Mordinals are ordinary test-chain transactions put on an owner list by hand.
  No `0x10` inscription was made, and the real owner list was used only for the timing.
- In these tests records were given to the ledger directly. Carrying them on chain (relay,
  reader, replaced blocks) is in [`../reader`](../reader), which uses this library unchanged.
- The one-time-key signing is new code and is not in any released wallet yet.
- Feather and Cake were checked by reading source, not by using the apps.
- No outside review. Fee cap, lowest price, reservation length and the other values listed
  in `RULES.md` section 7 are drafts. See [`../docs/OPEN-POINTS.md`](../docs/OPEN-POINTS.md).
- Test chain only: fee levels and timing on the real network were not measured.
