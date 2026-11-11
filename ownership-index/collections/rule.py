"""Display grouping from published inscription metadata; never infers Monero senders."""
import hashlib
import json
import re
import unicodedata
from urllib.parse import urlsplit

EXPLICIT = re.compile(r'\b(nsfw|porn(?:ographic|ography)?|hentai|nudity|nudes?|naked|erotic|sexually explicit|xxx)\b', re.I)
EDITION = re.compile(r'(?:\s*#\s*\d+\b|\s*№\s*\d+\b|\s+\b(?:no\.?|edition)\s*\d+\b|\s+\d+\s*/\s*\d+\b)', re.I)
URL = re.compile(r'https?://[^\s<>"\[\]]+', re.I)


def normalized(value):
    if value is None:
        return ''
    if isinstance(value, bytes):
        value = value.decode('utf-8', errors='replace')
    return ' '.join(unicodedata.normalize('NFKC', str(value)).replace('\ufeff', '').split()).strip(' "\'')


def group_hint(title, metadata=''):
    title = normalized(title)
    text = normalized(metadata)
    try:
        obj = json.loads(str(metadata))
    except (ValueError, TypeError):
        obj = None
    if isinstance(obj, dict):
        for key in ('collection', 'collection_name', 'collectionName', 'series'):
            value = obj.get(key)
            if isinstance(value, dict):
                value = value.get('name')
            if isinstance(value, str) and normalized(value):
                name = normalized(value)[:100]
                return identity('declared:' + name.casefold()), name, 'declared collection metadata'
    # Shared collection URLs can connect differently named editions. Generic
    # homepages and content-file URLs are deliberately not treated as collections.
    for match in URL.finditer(text or title):
        url = urlsplit(match.group().rstrip('.,;)'))
        path = url.path.rstrip('/')
        if url.hostname and path and not re.search(r'\.(?:png|jpe?g|gif|webp|mp4|html?)$', path, re.I) and not path.startswith('/content/'):
            link = url.hostname.lower() + path
            before = normalized((text or title)[:match.start()])
            name = EDITION.split(before)[0].strip(' -:') or link
            return identity('link:' + link), name[:100], 'shared collection link'
    prefix = EDITION.split(title, maxsplit=1)[0].strip(' -:')
    if prefix != title and len(prefix) >= 3:
        return identity('name:' + prefix.casefold()), prefix[:100], 'matching numbered names'
    if title and title.casefold() not in {'untitled inscription', 'untitled', 'none'}:
        # An exact shared description is a display group, never ownership proof.
        basis = text or title
        return identity('description:' + basis.casefold()), title[:100], 'shared description'
    return None


def identity(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def content_flag(title, metadata=''):
    return bool(EXPLICIT.search(str(title) + ' ' + str(metadata)))
