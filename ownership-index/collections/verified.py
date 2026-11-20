"""Puts the collections a creator published (verified/*.json) into collections.json.

A verified collection lists its members as the creator's own catalogue does: edition, Mordinal number, the
registration transaction and the Keccak-256 of the artwork. Every member must match this index
(../result/owners.jsonl) on all three, or nothing is written. The members are then taken out of every group the
metadata rule made, groups the file names under `replaces` are dropped, and the collection takes the id it names, so
links to that group keep working. Groups left with fewer than two Mordinals are dropped.

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
OWNERS = os.path.join(HERE, '..', 'result', 'owners.jsonl')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
ID = re.compile(r'^[0-9a-f]{24}$')
NOTE = ('Groups with basis "creator catalogue" come from a list the creator published (verified/), checked against '
        'this index by verified.py; their members are in no other group.')


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
        assert ID.match(v['id']) and isinstance(v['name'], str) and v['name'].strip(), name
        members = v['members']
        editions = [m['edition'] for m in members]
        numbers = [m['number'] for m in members]
        assert len(set(editions)) == len(members) and len(set(numbers)) == len(members), name + ': an edition or a Mordinal twice'
        for m in members:
            o = owners.get(m['number'])
            assert o is not None, f"{name}: Mordinal {m['number']} is not in this index"
            assert HEX64.match(m['registrationTx']) and m['registrationTx'] == o['registrationTx'], f"{name}: edition {m['edition']}: registration differs"
            assert HEX64.match(m['bodyKeccak256']) and m['bodyKeccak256'] == o['bodyKeccak256'], f"{name}: edition {m['edition']}: artwork differs"
        found.append({'file': name, 'id': v['id'], 'name': v['name'], 'basis': v.get('basis', 'creator catalogue'),
                      'replaces': v.get('replaces', []), 'numbers': set(numbers)})
    taken = {}
    for v in found:
        for n in v['numbers']:
            assert n not in taken, f"Mordinal {n} is in {taken[n]} and {v['file']}"
            taken[n] = v['file']
    return found


def apply(data, verified):
    out = dict(data)
    ours = {v['id']: v for v in verified}
    dropped = {i for v in verified for i in v['replaces']}
    every = set().union(*(v['numbers'] for v in verified)) if verified else set()
    groups = []
    for g in data['groups']:
        if g['id'] in ours:
            v = ours.pop(g['id'])
            groups.append({'id': v['id'], 'name': v['name'], 'basis': v['basis'], 'count': len(v['numbers']), 'numbers': ranges(v['numbers'])})
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
        groups.append({'id': v['id'], 'name': v['name'], 'basis': v['basis'], 'count': len(v['numbers']), 'numbers': ranges(v['numbers'])})
    kept = {g['id'] for g in groups}
    out['groups'] = groups
    out['featured'] = [i for i in data.get('featured', []) if i in kept]
    if verified and NOTE not in out.get('about', ''):
        out['about'] = (out.get('about', '') + ' ' + NOTE).strip()
    out['verified'] = [{'id': v['id'], 'name': v['name'], 'count': len(v['numbers']), 'file': v['file']} for v in verified]
    return out


def main():
    owners = {}
    for line in open(OWNERS, encoding='utf-8'):
        if line.strip():
            o = json.loads(line)
            owners[o['number']] = o
    data = json.load(open(GROUPS, encoding='utf-8'))
    text = json.dumps(apply(data, load_verified(owners)), separators=(',', ':')) + '\n'
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
