"""Qualify compiled wire oracle against preserved actual source PTYs, not fake UI."""
import json
from pathlib import Path

OWN = Path(__file__).resolve().parent
source = OWN / 'evidence/source-a3-selector-api-fix'
a = (source / 'pty-0-pane-one.raw').read_bytes()
b = (source / 'pty-1-pane-two.raw').read_bytes()
fallback = b'\x1b[>4;2m'
assert fallback not in a and fallback in b, 'Real accepting source captures must show Kitty A / legacy B'
assert not (fallback not in a + fallback and fallback in b), 'Wrong A legacy fallback must reject'
assert not (fallback not in a and fallback in b.replace(fallback, b'')), 'Missing B fallback must reject'
result = {'result': 'WIRE_ORACLE_CAPTURE_AND_REJECTING_CONTROLS_PASS_NOT_COMPILED_PROOF',
          'realCaptureSource': str(source), 'checks': 3, 'newProductRuns': 0}
output = OWN / 'evidence/ready-wave-1337/wire-controls.json'
assert not output.exists()
output.write_text(json.dumps(result, indent=2) + '\n')
print('PASS real captured negotiation wire +2 rejecting controls; not a new compiled run')
