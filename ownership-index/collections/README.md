# Collections

`collections.json` groups Mordinals into collections for browsing: GooGirls, Lame Kittens,
Lame Puppies, Lame Creatures, The First 1k NFT collection on Monero, Monero Rocks, Monero
Punks, Retarded Rat and the rest.

A group is made from what each inscription published about itself (its title, its
metadata and any collection link in them), with the rule in `rule.py`, the same rule
xmr20.org uses for its Mordinals archive:

1. a `collection` (or `collection_name`, `collectionName`, `series`) field in the metadata;
2. otherwise a shared collection link;
3. otherwise a shared name with an edition number (`Punk #12`);
4. otherwise an identical description.

Groups with at least two Mordinals of this index are kept. Inscriptions that the index does
not count (a body that was already registered, a fee below the rule) are left out, so some
groups are smaller here than in the archive.

A collection says how inscriptions present themselves. It says nothing about who made them
or who owns them, and the ownership rules never read it.

| Field | Meaning |
| --- | --- |
| `groups[].id` | 24 hex characters, from the rule |
| `groups[].name`, `display` | the name the rule found; `display` is a shorter name where one is used on xmr20.org |
| `groups[].basis` | which step of the rule made the group |
| `groups[].numbers` | Mordinal numbers, single or `[first, last]` ranges |
| `featured` | the groups xmr20.org shows first, in that order |
| `sensitiveByLabel` | Mordinals whose own title or metadata labels them explicit; pages hide their pictures until asked |
