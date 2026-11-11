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
| Start block (claims, moves, sales) | The newest block of the server's own node when the service is installed, pinned by its hash |
| First mint block | Not set at launch. Minting is switched on in a later step; the first release is Mordinals only |
| Ledger domain | `ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d` = SHA-256("XMR721 mainnet ledger 1") |
| Owner list | `ownership-index/result/owners.jsonl` + `ownership-index/added/added.jsonl` (42,895 Mordinals) |
| Who may mint | Anyone |
| Repository | Public at launch |

The fee address is a main mainnet address and passes the ledger's own check for usable
keys. The domain and the owner list are fixed now, so wallets can be built before the
start block is known.

Claims and trading of Mordinals launch first, as a tab of the Monero Market on xmr20.org. Minting follows later.
