"""Puts the collections checked by hand (verified/*.json) into collections.json.

Each file lists every member of one collection: Mordinal number, registration transaction and the Keccak-256 of the
artwork, and the edition where the creator numbered it. Every member must match this index (../result/owners.jsonl)
on number, transaction and artwork, or nothing is written. The members are then taken out of every group the
metadata rule made, groups the file names under `replaces` are dropped, and the collection takes the id it names, so
links to that group keep working (a new id adds a group). Groups left with fewer than two Mordinals are dropped.
featured.json, when present, sets the groups shown first.

Run it after collections.json is made from the archive with rule.py:

    python3 ownership-index/collections/verified.py           writes collections.json
    python3 ownership-index/collections/verified.py --check   writes nothing; fails if collections.json is not up to date
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GROUPS = os.path.join(HERE, 'collections.json')
FEATURED = os.path.join(HERE, 'featured.json')
OWNERS = os.path.join(HERE, '..', 'result', 'owners.jsonl')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
NAMED_FROM = 10
TITLE = re.compile(r'^[^\x00-\x1f\x7f]{1,80}$')
ID = re.compile(r'^[0-9a-f]{24}$')
NOTE = ('The groups named under "verified" were checked by hand (verified/): verified.py checked each of their members '
        'against this index, and they are in no other group.')
EARLIER_NOTES = ('Groups with basis "creator catalogue" come from a list the creator published (verified/), checked against '
                 'this index by verified.py; their members are in no other group.',)


def check(ok, message):
    # Not assert: the checks must also run under python -O.
    if not ok:
        sys.exit('verified.py: ' + message + '; nothing written')


def ranges(numbers):
    out = []
    for n in sorted(numbers):
        if out and isinstance(out[-1], list) and out[-1][1] == n - 1:
            out[-1][1] = n
        elif out and isinstance(out[-1], int) and out[-1] == n - 1:
            out[-1] = [out[-1], n]
        else:
            out.append(n)
    return out


def opened(numbers):
    return [n for x in numbers for n in (range(x[0], x[1] + 1) if isinstance(x, list) else [x])]


def load_verified(owners):
    found = []
    for path in sorted(glob.glob(os.path.join(HERE, 'verified', '*.json'))):
        v = json.load(open(path, encoding='utf-8'))
        name = os.path.relpath(path, HERE)
        check(ID.match(v['id']) and isinstance(v['name'], str) and v['name'].strip(), name)
        members = v['members']
        check(v.get('display') is None or isinstance(v['display'], str) and v['display'].strip(), name)
        editions = [m['edition'] for m in members if m.get('edition') is not None]
        numbers = [m['number'] for m in members]
        check(len(members) >= 2, name + ': fewer than two Mordinals')
        check(v.get('repeatedEditions') is True or len(set(editions)) == len(editions), name + ': an edition twice')
        check(len(set(numbers)) == len(members), name + ': a Mordinal twice')
        check(all(isinstance(e, int) and 0 <= e < 10 ** 6 for e in editions), name + ': an edition is not a number')
        titles = [m['title'] for m in members if m.get('title') is not None]
        check(all(isinstance(t, str) and TITLE.match(t) and t == t.strip() for t in titles), name + ': a title is not 1 to 80 printable characters')
        for m in members:
            o = owners.get(m['number'])
            check(o is not None, f"{name}: Mordinal {m['number']} is not in this index")
            check(HEX64.match(m['registrationTx']) and m['registrationTx'] == o['registrationTx'], f"{name}: Mordinal {m['number']}: registration differs")
            check(HEX64.match(m['bodyKeccak256']) and m['bodyKeccak256'] == o['bodyKeccak256'], f"{name}: Mordinal {m['number']}: artwork differs")
        found.append({'file': name, 'id': v['id'], 'name': v['name'], 'display': v.get('display'), 'basis': v.get('basis', 'creator catalogue'),
                      'replaces': v.get('replaces', []), 'numbers': set(numbers),
                      'editions': sorted((m['number'], m['edition']) for m in members if m.get('edition') is not None),
                      'titles': sorted((m['number'], m['title']) for m in members if m.get('title') is not None)})
    check(len({v['id'] for v in found}) == len(found), 'two files name the same id')
    taken = {}
    for v in found:
        for n in v['numbers']:
            check(n not in taken, f"Mordinal {n} is in {taken.get(n)} and {v['file']}")
            taken[n] = v['file']
    return found


def record(v):
    g = {'id': v['id'], 'name': v['name']}
    if v['display']:
        g['display'] = v['display']
    g |= {'basis': v['basis'], 'count': len(v['numbers']), 'numbers': ranges(v['numbers'])}
    if v['editions']:
        g['editions'] = [list(x) for x in v['editions']]
    if v['titles']:
        g['titles'] = [list(x) for x in v['titles']]
    return g


def apply(data, verified, featured=None):
    out = dict(data)
    ours = {v['id']: v for v in verified}
    dropped = {i for v in verified for i in v['replaces']}
    every = set().union(*(v['numbers'] for v in verified)) if verified else set()
    groups = []
    for g in data['groups']:
        if g['id'] in ours:
            v = ours.pop(g['id'])
            groups.append(record(v))
            continue
        if g['id'] in dropped:
            continue
        left = [n for n in opened(g['numbers']) if n not in every]
        if len(left) < 2:
            continue
        g = dict(g)
        g['count'] = len(left)
        g['numbers'] = ranges(left)
        groups.append(g)
    for v in ours.values():
        groups.append(record(v))
    # Members of a real collection take its name on the pages: a list checked by hand, or a group of at least
    # NAMED_FROM Mordinals. Smaller groups only share a description ("testing this") and name nobody.
    checked = {v['id'] for v in verified}
    for g in groups:
        g.pop('named', None)
        if g['id'] in checked or g['count'] >= NAMED_FROM:
            g['named'] = True
    kept = {g['id'] for g in groups}
    out['groups'] = groups
    if featured is not None:
        check(all(i in kept for i in featured) and len(set(featured)) == len(featured), 'featured.json names a group that is not kept')
        out['featured'] = list(featured)
    else:
        out['featured'] = [i for i in data.get('featured', []) if i in kept]
    about = out.get('about', '')
    for note in EARLIER_NOTES + (NOTE,):
        about = about.replace(' ' + note, '').replace(note, '')
    out['about'] = (about + ' ' + NOTE).strip() if verified else about
    out['verified'] = [{'id': v['id'], 'name': v['name'], 'count': len(v['numbers']), 'file': v['file']} for v in verified]
    return out


def main():
    owners = {}
    for line in open(OWNERS, encoding='utf-8'):
        if line.strip():
            o = json.loads(line)
            owners[o['number']] = o
    data = json.load(open(GROUPS, encoding='utf-8'))
    featured = json.load(open(FEATURED, encoding='utf-8'))['featured'] if os.path.exists(FEATURED) else None
    text = json.dumps(apply(data, load_verified(owners), featured), separators=(',', ':')) + '\n'
    if '--check' in sys.argv:
        if open(GROUPS, encoding='utf-8').read() != text:
            sys.exit('collections.json is not up to date: run verified.py')
        print('collections.json is up to date')
        return
    open(GROUPS, 'w', encoding='utf-8').write(text)
    for g in json.loads(text)['verified']:
        print(f"{g['name']}: {g['count']} Mordinals ({g['file']})")


if __name__ == '__main__':
    main()
