// The mainnet ledger: every value that makes a reader a reader of this ledger and of no other, in one place.
// RULES.md section 13 lists the same values; rules/tests/mainnet.test.mjs holds the two together and checks the owner
// list this repository ships against the hashes below.
//
// Nothing here is read from a server, a file outside this repository or the environment. A value below changes only
// by a new version of the rules (RULES.md section 14), and a new block only ever lies in the future: no version
// changes how a block before its own first block is judged.
const freeze=o=>Object.freeze(Object.fromEntries(Object.entries(o).map(([k,v])=>[k,Array.isArray(v)?Object.freeze([...v]):v])));

export const MAINNET=freeze({
 version:'1.0',
 network:'mainnet',
 // SHA-256("XMR721 mainnet ledger 1")
 domain:'ec7f7d26dba6725124df69417d43335c52e34557fc61c1d8d6b4736370e6ba1d',
 feeAddress:'45J4QMTbVoi61ZQoUzLVh7VkvjuRbqaaHW1AophY1Jbi9KzTzk8qoh43fT6JWYvkk6j6X1Stog7Xb9ZabzBrMr7tGzANudW',
 // The owner list: the two files in list order, and the two hashes that pin them (reader/lib/owners.mjs).
 owners:['ownership-index/result/owners.jsonl','ownership-index/added/added.jsonl'],
 ownersCount:42895,
 ownersHash:'e71d340d84538c229f9e190d221271873cde6b1daab8366d9b282ff016e639ee',
 ownerOutputsHash:'7f01d0149f44350f9b381d33598453219c3bf453ae79726c75f9b0bf1b11165f',
 // Claims, moves and sales count in the blocks after this one.
 start:3804029,
 startHash:'cddee72e248e6fc903d7850f73e29cceff64dd9a027f64afc7362d76784081cd',
 // Section 9: the first mint block, who may mint until the opening block, and the opening block.
 mintFrom:3805946,
 minters:['42zfMRhM9aQAXb4uZKw5gzVN9uTf3bUrgAz2cY7jpvbn8ZE4RWsBsKUECgXNiFKsqK9nBDPThFzTafsZX3bZ7socRQZU1qX','47hW3YWbqR5LrvJyfRSBAqArp8TcU1xnL29dn5xpEWJN9dmyohzaS4ug3e57yvSGmT3UWh47gfN4VW1soHSrXsmqD8haurE'],
 openFrom:3806220,
 // Section 10: the first burn block. The dead outputs and the fee wallet are mainnet's own (burn.mjs, burn-fee.mjs).
 burnFrom:3808200,
 // Section 11: the first block of claims by a spent coin.
 spendFrom:3813165,
 // XMR20 tokens as inscriptions (xmr20-tokens/): a view of the records above, not part of who owns an NFT.
 xmr20Inscribers:['42zfMRhM9aQAXb4uZKw5gzVN9uTf3bUrgAz2cY7jpvbn8ZE4RWsBsKUECgXNiFKsqK9nBDPThFzTafsZX3bZ7socRQZU1qX'],
 xmr20OpenFrom:3812510,
});

// The options reader/service.mjs takes, filled in for the mainnet ledger. `root` is the folder of this repository.
export const mainnetOptions=root=>({network:MAINNET.network,domain:MAINNET.domain,feeAddress:MAINNET.feeAddress,
 owners:MAINNET.owners.map(f=>`${root}/${f}`).join(','),start:MAINNET.start,startHash:MAINNET.startHash,
 mintFrom:MAINNET.mintFrom,minters:[...MAINNET.minters],openFrom:MAINNET.openFrom,burnFrom:MAINNET.burnFrom,spendFrom:MAINNET.spendFrom,
 xmr20Inscribers:[...MAINNET.xmr20Inscribers],xmr20OpenFrom:MAINNET.xmr20OpenFrom});
