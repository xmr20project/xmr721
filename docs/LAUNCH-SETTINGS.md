# Launch settings

Status: live on Monero mainnet. These values are part of the ledger's setup; every reader of
the ledger uses the same ones, and they cannot be changed afterwards without starting a new
ledger setting from a later block.

| Setting | Value |
| --- | --- |
| Network | Monero mainnet |
| Ledger domain | `ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d` = SHA-256("XMR721 mainnet ledger 1") |
| Owner list | `ownership-index/result/owners.jsonl` + `ownership-index/added/added.jsonl` (42,895 Mordinals); its hash is `e71d340d84538c229f9e190d221271873cde6b1daab8366d9b282ff016e639ee` |
| Start block (claims, moves, sales) | 3,804,029, hash `cddee72e248e6fc903d7850f73e29cceff64dd9a027f64afc7362d76784081cd` |
| Protocol fee | 5% of every sale (Mordinals and minted NFTs) |
| Protocol fee address | `45J4QMTbVoi61ZQoUzLVh7VkvjuRbqaaHW1AophY1Jbi9KzTzk8qoh43fT6JWYvkk6j6X1Stog7Xb9ZabzBrMr7tGzANudW` |
| Mint fee in the rules | None |
| First mint block | 3,805,946 |
| Opening block | 3,806,220: from this block on anyone makes collections and mints |
| Open XMR20 tokens | 3,812,510: from this block on anyone creates and mints open XMR20 tokens ([rules](../xmr20-tokens/OPEN.md)); reader option `--xmr20-open-from 3812510` |
| First burn block | 3,808,200: from this block on a Mordinal is claimed by burning it ([RULES.md](../RULES.md) section 10); claim records counted until block 3,808,919; reader option `--burn-from 3808200` |
| Claims by a spent coin | 3,813,165: from this block on a holder whose wallet builds no burn spends the owner coin in an ordinary transaction and claims with its signed key image ([RULES.md](../RULES.md) section 11); only a coin spent from this block on counts; the fee is the network fee of the transaction that carries the claim and 0.0025 XMR; reader option `--spend-from 3813165` |
| Claim records again | not set yet: from the block named here a holder claims by signature again, without spending the owner coin ([RULES.md](../RULES.md) section 12); reader option `--records-from <height>` |
| Who may mint | Until the opening block the listed minters: `42zfMRhM9aQAXb4uZKw5gzVN9uTf3bUrgAz2cY7jpvbn8ZE4RWsBsKUECgXNiFKsqK9nBDPThFzTafsZX3bZ7socRQZU1qX` (the XMR20 launchpad's inscriber) and `47hW3YWbqR5LrvJyfRSBAqArp8TcU1xnL29dn5xpEWJN9dmyohzaS4ug3e57yvSGmT3UWh47gfN4VW1soHSrXsmqD8haurE` (the Sweep and Burn issuer) |
| XMR20 token inscribers | `42zfMRhM9aQAXb4uZKw5gzVN9uTf3bUrgAz2cY7jpvbn8ZE4RWsBsKUECgXNiFKsqK9nBDPThFzTafsZX3bZ7socRQZU1qX` |
| Relay fee | None at present. Claims, moves, listings, reservations and purchases are always carried free |
| Repository | Public |

The fee address is a main mainnet address and passes the ledger's own check for usable
keys. The domain and the owner list were fixed before the start block, so wallets could be
built before it was known.

Claims and trading of Mordinals went live first, as a tab of the Monero Market on
xmr20.org; minting followed from the first mint block, for the listed minters, and is open to
everyone from the opening block. A reader that is started without the opening block, or with
another one, is a reader of another ledger from that block on.
