"""Real project-scoped submit/readback glue. Caller must complete local prerequisites first.
No polling: a pending CE task is retained and blocks; explicit --resume reuses the saved submission.
No token creation, global settings, visibility/profile/threshold or hotspot mutations.
"""
import base64
import json
import math
from pathlib import Path
import runpy
import subprocess
import time
import urllib.parse
import urllib.request

OWN = Path(__file__).resolve().parent
READBACK = runpy.run_path(str(OWN.parent / '1006-composed-qa/sonar-readback.py'), run_name='quality_sonar_readback')
TRANSPORT = runpy.run_path(str(OWN / 'scanner-fd.py'), run_name='quality_sonar_transport')
HOST = READBACK['HOST']
PROJECT = 'phsb5321_pi-memory-sound-qa'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Authenticated Sonar redirects forbidden')


class Pending(Exception):
    pass


class Sonar:
    def effect(self, kind):
        if time.monotonic() + 20 >= self.deadline:
            raise TimeoutError('Owned quality deadline reached')
        with (self.out / 'effects.jsonl').open('a') as stream:
            stream.write(json.dumps({'kind': kind}) + '\n')

    def __init__(self, out, deadline):
        self.out, self.reads, self.deadline = out, sorted(out.glob('*-read.json')), deadline
        # Reached only after exact compiled/API/maps/local ratchets and normal heavy admission.
        subprocess.run(['rbw', 'unlocked'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        self.effect('credential-get')
        self.token = subprocess.check_output(['rbw', 'get', 'sonar-pi-memory-sound-qa'], stderr=subprocess.DEVNULL, timeout=8).strip()
        # Only the existing project analysis token is authorized for this chain.
        # Reuse get_json's caller-supplied auth; never call its historical admin credential helper.
        self.authorization = 'Basic ' + base64.b64encode(self.token + b':').decode()
        self.redactor = TRANSPORT['Redactor'](self.token)
        self.redactor.patterns += (self.authorization.split(' ', 1)[1].encode(),)
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect))

    def get(self, path, params):
        assert path in ('/api/ce/task', '/api/project_analyses/search', '/api/new_code_periods/show',
                        '/api/qualitygates/project_status', '/api/measures/component', '/api/issues/search',
                        '/api/hotspots/search', '/api/components/tree', '/api/sources/lines', '/api/components/show')
        # Reuse the qualified private readback primitive; auth never enters URL/env/argv/log.
        self.effect('http')
        value = READBACK['get_json'](path, params, self.authorization)
        file = self.out / f'{len(self.reads):04d}-read.json'
        assert not file.exists(), 'Do not overwrite actual readback'
        raw = (json.dumps({'path': path, 'params': params, 'response': value}, indent=2) + '\n').encode()
        file.write_bytes(self.redactor.feed(raw, final=True))
        self.reads.append(file)
        return value

    def pages(self, path, params, field):
        rows, page = [], 1
        while True:
            assert page <= 100, 'Sonar page bound exceeded'
            result = self.get(path, {**params, 'p': page, 'ps': 100})
            paging = result['paging']
            assert paging['pageIndex'] == page and 0 < paging['pageSize'] <= 100
            items = result[field]
            rows.extend(items)
            assert len(rows) <= paging['total']
            if len(rows) == paging['total']:
                return rows
            assert items, 'Missing Sonar page'
            page += 1

    def latest(self):
        result = self.get('/api/project_analyses/search', {'project': PROJECT, 'p': 1, 'ps': 1})
        assert result['analyses'], 'Missing actual analysis'
        return result['analyses'][0]

    def completed(self, task_id, revision, version):
        task = self.get('/api/ce/task', {'id': task_id})['task']
        if task.get('status') in ('PENDING', 'IN_PROGRESS'):
            raise Pending('CE pending: retain submission; no rescan or in-lease polling')
        assert task.get('componentKey') == PROJECT and task.get('status') == 'SUCCESS' and task.get('analysisId'), 'CE failed/wrong project'
        analysis = self.latest()
        assert analysis['key'] == task['analysisId'] and analysis.get('revision') == revision, 'Analysis/task revision mismatch'
        versions = [event['name'] for event in analysis.get('events', []) if event.get('category') == 'VERSION']
        assert version in versions, 'Actual analysis version missing/mismatched'
        return task['analysisId']

    def submit(self, view, version, revision, sources, log, task_path, lcov=None):
        settings = {'sonar.host.url': HOST, 'sonar.projectKey': PROJECT, 'sonar.projectVersion': version,
                    'sonar.scm.revision': revision, 'sonar.scm.provider': 'git', 'sonar.projectBaseDir': str(view),
                    'sonar.sources': ','.join(sources), 'sonar.sourceEncoding': 'UTF-8',
                    'sonar.working.directory': str(task_path.parent / 'scanner-work'),
                    'sonar.scanner.metadataFilePath': str(task_path), 'sonar.javascript.node.maxspace': '512',
                    'sonar.qualitygate.wait': 'false'}
        if lcov:
            settings['sonar.javascript.lcov.reportPaths'] = str(lcov)
        assert not any('\n' in value or '\r' in value or '\\' in value for value in settings.values())
        payload = '\n'.join(f'{key}={value}' for key, value in settings.items()).encode()
        self.effect('scanner-launch')
        report = TRANSPORT['run_scanner'](self.token, payload, log, timeout=90)
        assert report['exit'] == 0 and not report['timedOut'] and report['fdClosed'] and report['childReaped'], 'Real scanner failed'
        props = dict(line.split('=', 1) for line in task_path.read_text().splitlines() if '=' in line)
        assert props['projectKey'] == PROJECT and props['serverUrl'].rstrip('/') == HOST and props.get('ceTaskId'), 'Wrong scanner report-task'
        return report, props['ceTaskId']

    def pin(self, analysis_id):
        params = {'project': PROJECT, 'type': 'SPECIFIC_ANALYSIS', 'value': analysis_id}
        request = urllib.request.Request(HOST + '/api/new_code_periods/set', data=urllib.parse.urlencode(params).encode(),
                    headers={'Authorization': self.authorization}, method='POST')
        self.effect('http')
        with urllib.request.urlopen(request, timeout=15) as response:
            assert response.status in (200, 204), 'Project-only baseline set failed'
        readback = self.get('/api/new_code_periods/show', {'project': PROJECT})
        assert readback['projectKey'] == PROJECT and readback['type'] == 'SPECIFIC_ANALYSIS' and readback['value'] == analysis_id, 'Returned baseline pin mismatch'
        return readback

    def candidate(self, analysis_id, baseline_id, manifest, coverage):
        pin = self.get('/api/new_code_periods/show', {'project': PROJECT})
        assert pin['projectKey'] == PROJECT and pin['type'] == 'SPECIFIC_ANALYSIS' and pin['value'] == baseline_id
        assert self.latest()['key'] == analysis_id, 'Candidate superseded before readback'
        gate = self.get('/api/qualitygates/project_status', {'analysisId': analysis_id})['projectStatus']
        measured = self.get('/api/measures/component', {'component': PROJECT, 'metricKeys': ','.join(READBACK['METRICS'])})['component']
        assert measured['key'] == PROJECT
        metrics = {}
        for row in measured['measures']:
            raw = row.get('value', row.get('period', {}).get('value'))
            if raw is not None:
                value = float(raw)
                assert math.isfinite(value) and value >= 0
                metrics[row['metric']] = value
        issues = self.pages('/api/issues/search', {'componentKeys': PROJECT, 'inNewCodePeriod': 'true'}, 'issues')
        hotspots = self.pages('/api/hotspots/search', {'projectKey': PROJECT, 'inNewCodePeriod': 'true'}, 'hotspots')
        components = self.pages('/api/components/tree', {'component': PROJECT, 'strategy': 'leaves', 'qualifiers': 'FIL'}, 'components')
        files = {row['path']: row['key'] for row in components}
        assert set(files) == {row['path'] for row in manifest['eligibleSources']}, 'Sonar omitted/added eligible source'
        source_counts = {}
        for path in manifest['expectedNewSources']:
            lines, start = [], 1
            while True:
                assert start < 200001, 'Source readback bound exceeded'
                page = self.get('/api/sources/lines', {'key': files[path], 'from': start, 'to': start + 499})['sources']
                assert all(row['line'] == start + index for index, row in enumerate(page)), 'Skipped SCM line page'
                lines.extend(page)
                if len(page) < 500:
                    break
                start += 500
            new = [row for row in lines if row.get('isNew') is True]
            counts = {'lines': {'total': sum('lineHits' in row for row in new), 'covered': sum(row.get('lineHits', 0) > 0 for row in new)},
                      'conditions': {'total': sum(row.get('conditions', 0) for row in new), 'covered': sum(row.get('coveredConditions', 0) for row in new)}}
            assert counts == coverage['newCodeSources'][path], 'Actual Sonar SCM/condition partition differs; do not fabricate reconciliation'
            source_counts[path] = counts
        assert self.latest()['key'] == analysis_id, 'Concurrent candidate changed during full readback'
        assert gate['status'] == 'OK' and not issues and all(row.get('status') == 'REVIEWED' for row in hotspots), 'Real issue/hotspot/quality gate RED'
        for key, (direction, threshold) in READBACK['METRICS'].items():
            assert key in metrics, 'Missing quality metric: ' + key
            assert metrics[key] >= threshold if direction == 'min' else metrics[key] <= threshold, 'Real metric RED: ' + key
        return {'scanExecuted': True, 'ceStatus': 'SUCCESS', 'analysisId': analysis_id, 'projectKey': PROJECT,
                'baselineAnalysisId': baseline_id, 'candidateIdentity': manifest['identity'], 'revision': manifest['candidateRevision'],
                'qualityGate': gate['status'], 'unreviewedHotspots': 0, 'allPagesRead': True, 'metrics': metrics, 'sourceCounts': source_counts}
