# Launch settings

Status: chosen, not live. These values are fixed in the ledger at launch and cannot be
changed afterwards without starting a new ledger.

| Setting | Value |
| --- | --- |
| Network | Monero mainnet |
| Protocol fee | 5% of every sale (Mordinals and minted NFTs) |
| Protocol fee address | `45J4QMTbVoi61ZQoUzLVh7VkvjuRbqaaHW1AophY1Jbi9KzTzk8qoh43fT6JWYvkk6j6X1Stog7Xb9ZabzBrMr7tGzANudW` |
| Mint fee in the rules | None |
| Relay fee | 0.0005 XMR for each collection or mint record the relay carries (`--mint-fee 500000000 --collection-fee 500000000`). Claims, moves, listings, reservations and purchases are carried free |
| Start block (claims, moves, sales) | Set on launch day: a block a little above the chain tip at that time |
| First mint block | The start block. Collections, mints and burns count from the first block of the ledger |
| Who may mint | Anyone |
| Repository | Public at launch |

The fee address is a main mainnet address and passes the ledger's own check for usable
keys. The ledger domain is derived at launch from the final settings and the owner-list
hash, and is then built into the reader and the wallets.

Claims, trading and minting launch together.
