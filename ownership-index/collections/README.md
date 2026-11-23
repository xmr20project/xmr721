# Collections

`collections.json` groups Mordinals into collections for browsing: GooGirls, Lame Kittens,
Lame Puppies, Lame Creatures, Monero Punks, Monero Rocks, Retarded Rats and the rest.

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

## Collections checked by hand

Where a creator published the list of their editions, or the published text leaves a
member out, a list in `verified/` decides membership instead of the metadata rule. Each
file holds every member: Mordinal number, registration transaction, the Keccak-256 of its
artwork, and the edition where the creator numbered it. `verified.py` checks every member
against this index (`../result/owners.jsonl`) and writes nothing if one differs; it then
gives the collection its members, takes them out of every other group, drops the groups a
file names under `replaces` and those left with fewer than two Mordinals, and copies the
order in `featured.json`. Run it after making `collections.json` with the rule;
`verified.py --check` fails if `collections.json` is not up to date.

Some creators inscribed their list as a Mordinal: a picture of every edition, with each
edition's mordinals.org item number, which is the Mordinal number of this index. Such a
list Mordinal belongs to its collection.

- `elite-black-amex.json`: the creator's signed list (Mordinal 30,680) of editions 1–100,
  the list itself, and two more registrations titled as editions (103).
- `retarded-rats.json`: the creator's signed list (Mordinal 22,427) of Rat 1–30, the list,
  and one more registration titled as a Rat (32).
- `xmrgirls.json`: the creator's list (Mordinal 19,830) of girl 1–30 and the list (31).
- `artifacts.json`: the 50 pictures of "The first and only collections of 100 Artifacts
  under 5,000 Mordinals", including Mordinal 1,697, whose text says "under 5K Mordinals".
- `monero-chan.json`: Monero Chan Morbinal #2–#10 and Mordinal 144, "The first ever Monero
  Chan Morbinal."
- `eternal-monero-bubbles.json`: "The eternal monero bubble(s)", Bubble 1 to 5 of 5.
- `monero-rocks.json`, `chad.json`, `hydra-society.json`, `deus-finance-torus.json`: numbered in
  their own titles; members keep the number their title gives, also where an edition was
  registered more than once with different pictures (`repeatedEditions`).

- `xmr-punks-black.json`: 100 untitled 24 x 24 Punks on a black ground with orange XMR caps,
  registered in one run (Mordinal 1,873 and 1,929–2,027); found by their pictures. No text
  names them; the name describes them.
- `the-ape-society.json`: 28 painted ape portraits, each titled "<name> is a distinguished
  citizen of The Ape Society." The titles differ by name, so the rule did not group them;
  each member is named by its own (`title`, e.g. "Sir Fulton Brown").

A member's edition is the creator's number, not its Mordinal number: Mordinal 2 is Monero
Punk #0. Members without one are named by their collection alone.

- `verified/monero-punks.json`: the 1,019 Monero Punks (editions 0–1018) from the
  moneropunks.com gallery of March 2023. Anyone could pick a Punk there and register it, so
  the registrations carry many different descriptions; 297 shared the description of the
  group `d28d5a234cafb895f949ebd3`, which keeps its id and is now named Monero Punks.
  Among the inscriptions titled "Monero Punks #n", only Mordinal 1,124 is a creator edition (Punk #155); the
  other 32 are 200 × 200 copies and are left ungrouped.

| Field | Meaning |
| --- | --- |
| `groups[].id` | 24 hex characters, from the rule; a list in `verified/` keeps the id of the group it replaces or sets a new one |
| `groups[].name`, `display` | the name the rule found (or a list gives); `display` is a shorter name where one is used on xmr20.org |
| `groups[].basis` | which step of the rule made the group, or `creator catalogue` |
| `groups[].numbers` | Mordinal numbers, single or `[first, last]` ranges |
| `groups[].named` | true for a real collection (a list in `verified/`, or at least 10 Mordinals): its members are named after it; members of smaller groups keep "Mordinal #n" |
| `groups[].titles` | `[Mordinal, title]` pairs: a member's own title where the creator gave each one a name ("Sir Fulton Brown"); pages name it by that title |
| `groups[].editions` | `[Mordinal, edition]` pairs: the number a creator gave a member (in its list or its title); pages name it "<collection> #<edition>" |
| `featured` | the groups xmr20.org shows first, in that order |
| `verified` | the collections checked by hand, and their files |
| `sensitiveByLabel` | Mordinals whose own title or metadata labels them explicit; pages hide their pictures until asked |
