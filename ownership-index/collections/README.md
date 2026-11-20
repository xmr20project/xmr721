# Collections

`collections.json` groups Mordinals into collections for browsing: GooGirls, Lame Kittens,
Lame Puppies, Lame Creatures, Monero Punks, Monero Rocks, Retarded Rat and the rest.

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

## Collections from a creator's list

Where a creator published the list of their editions, that list decides membership instead
of the metadata. Each file in `verified/` holds one such list: every edition with its
Mordinal number, registration transaction and the Keccak-256 of its artwork. `verified.py`
checks every edition against this index (`../result/owners.jsonl`) and writes nothing if
one differs; it then gives the collection its members, takes them out of every other group,
drops the groups the file names under `replaces` and those left with fewer than two
Mordinals. Run it after making `collections.json` with the rule; `verified.py --check`
fails if `collections.json` is not up to date.

- `verified/monero-punks.json`: the 1,019 Monero Punks (editions 0–1018) from the
  moneropunks.com gallery of March 2023. Anyone could pick a Punk there and register it, so
  the registrations carry many different descriptions; 297 shared the description of the
  group `d28d5a234cafb895f949ebd3`, which keeps its id and is now named Monero Punks.
  Among the inscriptions titled "Monero Punks #n", only #1,124 is a creator edition; the
  other 32 are 200 × 200 copies and are left ungrouped.

| Field | Meaning |
| --- | --- |
| `groups[].id` | 24 hex characters, from the rule |
| `groups[].name`, `display` | the name the rule found; `display` is a shorter name where one is used on xmr20.org |
| `groups[].basis` | which step of the rule made the group, or `creator catalogue` |
| `groups[].numbers` | Mordinal numbers, single or `[first, last]` ranges |
| `featured` | the groups xmr20.org shows first, in that order |
| `verified` | the collections taken from a creator's list, and their files |
| `sensitiveByLabel` | Mordinals whose own title or metadata labels them explicit; pages hide their pictures until asked |
