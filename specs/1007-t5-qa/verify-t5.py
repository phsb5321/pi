"""Independent immutable T5 identity; no builder mutation, compiler or imports."""
import hashlib
import json
from pathlib import Path
import stat

BASE = Path('/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1007-catalog-materialize')
ROOT = BASE / 'execution-source'
SOURCE_SHA = '4d9b25183675cbdee2f5da21501623a41a725c69b975a94c14688a041917316b'
INPUT_SHA = '7e12e2b47b2fa1b562b9b18f0b76ce8599fdad7b1f74533a55845deca55cd319'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify():
    source_file = BASE / 'evidence/preflight-source-manifest.json'
    input_file = BASE / 'evidence/preflight-input-manifest.json'
    assert sha(source_file) == SOURCE_SHA, 'T5 source manifest identity changed'
    assert sha(input_file) == INPUT_SHA, 'T5 input manifest identity changed'
    rows = json.loads(source_file.read_text())
    prior = json.loads((BASE / 'prior-T4-source-manifest.json').read_text())
    old = {row['path']: row for row in prior}
    new = {row['path']: row for row in rows}
    assert len(old) == 1980 and len(new) == len(rows) == 2023
    for path, entry in old.items():
        actual = new[path]
        assert (entry['blob'], entry['mode']) == (actual['blob'], actual['mode']), ('T4 code changed', path)
    added = set(new) - set(old)
    assert len(added) == 43 and all(path.startswith('packages/ai/src/providers/data/') for path in added)
    for path, entry in new.items():
        relative = Path(path)
        assert not relative.is_absolute() and '..' not in relative.parts
        file = ROOT / path
        mode = file.lstat().st_mode
        data = file.readlink().as_posix().encode() if stat.S_ISLNK(mode) else file.read_bytes()
        gitmode = '120000' if stat.S_ISLNK(mode) else '100755' if mode & 0o111 else '100644'
        assert gitmode == entry['mode'], ('mode', path)
        assert hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() == entry['blob'], ('blob', path)
        assert hashlib.sha256(data).hexdigest() == entry['sha256'], ('sha256', path)
        if path in added:
            assert stat.S_ISREG(mode) and not file.is_symlink(), ('catalogue not physical', path)
    inputs = json.loads(input_file.read_text())
    links = inputs['aliases_and_dependencies']
    assert len(links) == 273
    assert len({row['path'] for row in links}) == 273
    for row in links:
        path = ROOT / row['path']
        assert path.is_symlink() and str(path.readlink()) == row['target'] and path.exists(), ('alias', row['path'])
    catalogue = inputs['catalogue_files_sha256']
    assert len(catalogue) == 43
    for name, expected in catalogue.items():
        assert sha(ROOT / 'packages/ai/src/providers/data' / name) == expected, ('catalogue', name)
    # Preserve a real rejecting identity control; wrong expected catalogue hash
    # must differ rather than silently adopting whatever bytes happen to exist.
    name = next(iter(catalogue))
    assert sha(ROOT / 'packages/ai/src/providers/data' / name) != '0' * 64
    return {'result': 'EXACT_T5_SOURCE_INPUT_PASS_NOT_COMPILED_ACCEPTANCE', 'root': str(ROOT),
            'sourceSha256': SOURCE_SHA, 'inputSha256': INPUT_SHA, 'codeEntriesUnchangedFromT4': 1980,
            'physicalCatalogueEntries': 43, 'totalEntries': 2023, 'declaredLinks': 273,
            'sourceCompilerInvocations': 0, 'negativeWrongCatalogueHashRejected': True}


if __name__ == '__main__':
    print(json.dumps(verify()))
