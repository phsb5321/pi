"""Read-only Sonar project/token/baseline discovery. Never submit/create/print secrets."""
import base64
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request

OWN = Path(__file__).resolve().parent
HOST = 'https://sonarqube.home301server.com.br'
OUT = OWN / 'evidence/ready-wave-1337/sonar-preflight-standard.json'
assert not OUT.exists(), 'Preserve existing grant-discovery evidence'
OUT.parent.mkdir(parents=True, exist_ok=True)
report = {'status': 'BLOCKED', 'host': HOST, 'readOnly': True, 'scans': 0, 'credentialsPrinted': False}
try:
    subprocess.run(['rbw', 'unlocked'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    entries = subprocess.check_output(['rbw', 'list'], text=True).splitlines()
    names = [name for name in entries if name.startswith('sonar-')]
    report['existingSonarEntryNames'] = names
    password = subprocess.check_output(['rbw', 'get', 'sonarqube.home301server.com.br'], text=True).strip()
    authorization = 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()

    def get(path, **params):
        request = urllib.request.Request(HOST + path + '?' + urllib.parse.urlencode(params),
                                        headers={'Authorization': authorization, 'User-Agent': 'curl/8.17.0'})
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.load(response)

    projects = get('/api/components/search', qualifiers='TRK', ps=500)
    report['readAuthForm'] = 'verified-standard-basic'
    assert projects['paging']['total'] <= 500, 'Incomplete project enumeration'
    candidates = [row for row in projects['components'] if row['key'] in ('phsb5321_pi', 'earendil-works_pi')
                  or row.get('name', '').lower() in ('pi', 'pi-monorepo', 'memory-sound')]
    report['enumeratedProjectKeys'] = [row['key'] for row in projects['components']]
    report['piProjectCandidates'] = [{'key': row['key'], 'name': row.get('name')} for row in candidates]
    tokens = get('/api/user_tokens/search', login='admin').get('userTokens', [])
    candidate_keys = {row['key'] for row in candidates}
    relevant = [row for row in tokens if row.get('projectKey') in candidate_keys
                or 'pi' in row.get('name', '').lower() or row.get('name') == 'sonar-local']
    report['candidateTokenMetadata'] = [{key: row.get(key) for key in
                                       ('name', 'type', 'projectKey', 'expirationDate', 'lastConnectionDate')}
                                      for row in relevant]
    report['baselineReads'] = {}
    for row in candidates:
        key = row['key']
        report['baselineReads'][key] = {
            'newCodePeriod': get('/api/new_code_periods/show', project=key),
            'latestAnalysis': get('/api/project_analyses/search', project=key, ps=1),
            'branches': get('/api/project_branches/list', project=key),
        }
    if not candidates:
        report['missingGrants'] = ['No existing Pi project/approved isolated analysis-view mapping found in live project enumeration',
                                   'No matching existing PROJECT_ANALYSIS_TOKEN/projectKey mapping for Pi',
                                   'No approved Pi new-code/clone-ratchet baseline mapping']
    else:
        # A server project alone is not permission to overwrite its Community main.
        report['missingGrants'] = ['Explicit approved Pi analysis-view/projectKey and unchanged new-code baseline mapping',
                                   'Exact matching rbw PROJECT_ANALYSIS_TOKEN entry; unrelated sonar-local/piorchestrator not borrowed',
                                   'Approved clone-ratchet baseline for this frozen tuple']
except (subprocess.CalledProcessError, urllib.error.URLError, KeyError, AssertionError) as error:
    report['errorType'] = type(error).__name__
    report['error'] = str(error) if not isinstance(error, subprocess.CalledProcessError) else 'rbw command failed; no secret output retained'
    report['missingGrants'] = ['Existing Sonar admin browse/gate-read credential did not verify; see exact HTTP/error evidence',
                               'Approved Pi projectKey/isolated analysis-view, matching PROJECT_ANALYSIS_TOKEN and unchanged new-code/clone baseline mapping remain unverifiable; no scan allowed']
finally:
    OUT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: report.get(key) for key in ('status', 'piProjectCandidates', 'missingGrants', 'errorType', 'error')}))
