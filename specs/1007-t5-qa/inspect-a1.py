"""Bounded read-only forensic summary of the already executed own A1 packet."""
import json
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parent / 'evidence/source-a1'
resident = json.loads((root / 'sessions/pane-one.resident.json').read_text())
with sqlite3.connect(f'file:{Path(resident["directory"]) / "session.sqlite"}?mode=ro', uri=True) as db:
    for table in ('tasks', 'submissions'):
        rows = [json.loads(row[0]) for row in db.execute(f'SELECT record FROM {table}')]
        for row in rows:
            if 'aborted' in json.dumps(row):
                print(table, json.dumps({key: value for key, value in row.items() if key not in ('input', 'content', 'entry')}))
print('Native classify() invokes runtime.signal.throwIfAborted before appending assistant messages; terminal receipts are the authoritative cancellation oracle, not current view strings.')
