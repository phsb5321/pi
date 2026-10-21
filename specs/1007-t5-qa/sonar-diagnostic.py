"""Bounded diagnostic only: rbw metadata and canonical-origin read auth, zero scans."""
import base64
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

OUT = Path(__file__).resolve().parent / 'evidence/ready-wave-1337/sonar-diagnostic.json'
assert not OUT.exists()
password = subprocess.check_output(['rbw', 'get', 'sonarqube.home301server.com.br'], text=True).strip()
metadata = subprocess.check_output(['rbw', 'get', 'sonar-local', '--full'], text=True)
report = {'scans': 0, 'entryInspectedWithoutPrinting': 'sonar-local', 'tokenUsed': False,
          'metadataSaysProjectAnalysisToken': 'PROJECT_ANALYSIS_TOKEN' in metadata,
          'metadataSaysUserToken': 'USER_TOKEN' in metadata,
          'recognizedPiProjectInMetadata': [key for key in ('phsb5321_pi', 'earendil-works_pi') if re.search(r'\b' + re.escape(key) + r'\b', metadata)],
          'reads': []}
for suffix in (':', ''):
    auth = base64.b64encode(('admin:' + password + suffix).encode()).decode()
    request = urllib.request.Request('https://sonarqube.home301server.com.br/api/authentication/validate',
        headers={'Authorization': 'Basic ' + auth, 'User-Agent': 'curl/8.17.0'})
    row = {'authForm': 'canonical-trailing-colon' if suffix else 'standard-basic'}
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            row.update(http=response.status, authentication=json.load(response))
    except urllib.error.HTTPError as error:
        body = error.read(8192).decode(errors='replace').lower()
        row.update(http=error.code, server=error.headers.get('Server'), cfMitigated=error.headers.get('cf-mitigated'),
                   bodyCategory='cloudflare-challenge' if 'just a moment' in body or 'cf-chl-' in body else
                   'sonar-insufficient-permissions' if 'insufficient' in body and 'privilege' in body else 'other-forbidden-response')
    except urllib.error.URLError as error:
        row.update(errorType=type(error).__name__)
    report['reads'].append(row)
OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
