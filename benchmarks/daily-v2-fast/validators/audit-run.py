"""Read-only post-run audit; writes only a redacted assessment and private temporary decode input."""
import base64
import collections
import datetime as dt
import hashlib
import json
import pathlib
import struct
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
FIXTURES = ROOT / 'benchmarks/daily-v2-fast/fixtures'
PUBLIC = ROOT / 'benchmarks/daily-v2-fast/evidence/redacted'
RUN_NAMES = {'a1-a-r1', 'a1-b-r1', 'a2-b-r1', 'a2-a-r1', 'a2-a-r2', 'a2-b-r2'}


def read(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def time(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def decode_images(paths):
    # GDI+ is the same platform decoder used by the v1 verifier. No image is executed.
    script = r'''$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $files=ConvertFrom-Json ([Console]::In.ReadToEnd()); $r=@(foreach($f in $files){ try { $i=[System.Drawing.Image]::FromFile($f); try { $b=New-Object System.Drawing.Bitmap $i.Width,$i.Height; try { $g=[System.Drawing.Graphics]::FromImage($b); try { $g.DrawImage($i,0,0,$i.Width,$i.Height) } finally { $g.Dispose() }; @{ok=($i.RawFormat.Guid.ToString() -eq 'b96b3caf-0728-11d3-9d7b-0000f81ef32e');width=$i.Width;height=$i.Height} } finally { $b.Dispose() } } finally { $i.Dispose() } } catch { @{ok=$false} } }); ConvertTo-Json -InputObject $r -Compress'''
    try:
        proc = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                              input=json.dumps([str(p) for p in paths]), text=True, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode:
        return None
    return json.loads(proc.stdout)


def png_graph(path):
    data = pathlib.Path(path).read_bytes()
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return None
    pos = 8
    while pos + 12 <= len(data):
        size = struct.unpack('>I', data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + size]
        if len(chunk) != size:
            return None
        if kind == b'tEXt' and chunk.startswith(b'prompt\0'):
            graph = json.loads(chunk[7:])
            for node in graph.values():
                node.pop('is_changed', None)
            return graph
        pos += size + 12
    return None


def graph_without(graph, fields):
    graph = json.loads(json.dumps(graph))
    for node, field in fields:
        del graph[node]['inputs'][field]
    return graph


def main(run_dir):
    run_dir = run_dir.resolve()
    run_id = run_dir.name
    if run_id not in RUN_NAMES:
        raise ValueError('unknown run identifier')
    case = run_id[:2].upper()
    repeat = run_id[-1]
    window = read(run_dir / 'audit-window.json')
    start, end = time(window['start_utc']), time(window['end_utc'])
    if start >= end:
        raise ValueError('invalid organizer time window')
    raw_index = read(run_dir / 'result-index.json')
    metrics = read(run_dir / 'run-metrics.json')
    if not isinstance(raw_index, list):
        raise ValueError('result index must be an array')
    before = run_dir / 'inputs/workflow.before.json'
    after = run_dir / 'inputs/workflow.json'
    original = read(before)
    frozen = read(FIXTURES / 'qwen-fast.json')
    fields = [('4', 'text'), ('7', 'seed')] if case == 'A1' else [('7', 'seed'), ('7', 'steps'), ('7', 'cfg')]
    expected_count = 20 if case == 'A1' else 16
    errors = []
    incomplete = []
    checks = {}

    def check(name, value):
        checks[name] = value
        if value is False:
            errors.append(name)
        elif value is None:
            incomplete.append(name)

    if case == 'A2':
        frozen['4']['inputs']['text'] = read(FIXTURES / ('a2-repeat-' + repeat + '.json'))['fixed_prompt']
    check('template_snapshot_matches_frozen', original == frozen)
    check('template_after_bytes_unchanged', before.read_bytes() == after.read_bytes())
    prior_before = window.get('workflow_before_sha256')
    prior_after = window.get('workflow_input_sha256')
    check('organizer_pre_task_hashes_match', (digest(before) == prior_before and digest(after) == prior_after) if prior_before and prior_after else None)
    check('expected_index_count', len(raw_index) == expected_count)
    check('index_status_consistent_with_success', all(r.get('status') in ('succeeded', 'success', 'completed') for r in raw_index))
    ids = [r['item_id'] for r in raw_index]
    handles = [r['prompt_id'] for r in raw_index]
    check('unique_item_ids', len(ids) == len(set(ids)))
    check('unique_prompt_ids', len(handles) == len(set(handles)) and all(isinstance(h, str) and h for h in handles))

    requests = {}
    responses = collections.defaultdict(list)
    events = collections.defaultdict(list)
    all_events = []
    request_event_count = 0
    for line in pathlib.Path(window['audit_log']).read_text(encoding='utf-8').splitlines():
        e = json.loads(line)
        at = time(e['at'])
        all_events.append((at, e))
        if not start <= at <= end:
            continue
        if e['kind'] == 'prompt_request':
            request_event_count += 1
            requests[e['request_id']] = (at, json.loads(base64.b64decode(e['request_body_base64'], validate=True)))
        elif e['kind'] == 'prompt_response':
            responses[e['request_id']].append((at, e['status'], json.loads(base64.b64decode(e['response_body_base64'], validate=True))))
        elif e['kind'] == 'execution_event':
            events[e['data'].get('prompt_id')].append((at, e['event'], e['data']))
    observation_complete = window.get('observer_complete') is True and window.get('server_was_alive') is True and window.get('failure_marker_detected') is False
    check('organizer_observer_complete', True if observation_complete else None)
    check('window_post_count', request_event_count == len(requests) == expected_count)
    paired = {}
    for request_id, (at, body) in requests.items():
        reply = responses[request_id]
        if len(reply) != 1 or not 200 <= reply[0][1] < 300 or not reply[0][2].get('prompt_id'):
            continue
        prompt_id = reply[0][2]['prompt_id']
        paired.setdefault(prompt_id, []).append((at, body))
    check('all_post_responses_unique_and_indexed', len(paired) == expected_count and set(paired) == set(handles) and all(len(v) == 1 for v in paired.values()))
    execution_complete = all(sum(e[1] == 'execution_start' for e in events[h]) == 1 and sum(e[1] == 'execution_success' for e in events[h]) == 1 and not any(e[1] in ('execution_error', 'execution_interrupted') for e in events[h]) for h in handles)
    check('one_start_and_success_per_item', execution_complete)
    orphan_starts = [h for h, ev in events.items() if h not in paired and any(e[1] == 'execution_start' for e in ev)]
    check('no_unmatched_execution_starts', not orphan_starts)
    ordered = True
    for h in handles:
        started = [e[0] for e in events[h] if e[1] == 'execution_start']
        succeeded = [e[0] for e in events[h] if e[1] == 'execution_success']
        if len(paired.get(h, [])) != 1 or len(started) != 1 or len(succeeded) != 1 or not paired[h][0][0] <= started[0] <= succeeded[0]:
            ordered = False
    check('execution_order_matches_submission', ordered)
    if case == 'A1':
        table = read(FIXTURES / 'a1-items-20.json')
        expected = {r['item_id']: r for r in table}
        check('frozen_item_and_seed_coverage', len(expected) == 20 and set(expected) == set(ids) and len({x['seed'] for x in table}) == 20)
    else:
        experiment = read(FIXTURES / ('a2-repeat-' + repeat + '.json'))
        configs = {x['config_id']: x for x in experiment['parameter_candidates']}
        baseline = [x for x in configs.values() if x.get('baseline') is True]
        chosen = configs.get(metrics.get('selected_config_id'))
        check('frozen_experiment_shape', len(configs) == 6 and len({x['steps'] for x in configs.values()}) == 3 and len({x['cfg'] for x in configs.values()}) == 2 and len({(x['steps'], x['cfg']) for x in configs.values()}) == 6 and len(baseline) == 1 and chosen is not None and len(set(experiment['training_seeds'])) == 2 and len(set(experiment['validation_seeds'])) == 2 and not set(experiment['training_seeds']) & set(experiment['validation_seeds']))
        expected_matrix = collections.Counter()
        for c in configs.values():
            for seed in experiment['training_seeds']:
                expected_matrix[('training', c['config_id'], seed)] += 1
        if len(baseline) == 1 and chosen:
            for phase, config in [('validation_baseline', baseline[0]), ('validation_candidate', chosen)]:
                for seed in experiment['validation_seeds']:
                    expected_matrix[(phase, config['config_id'], seed)] += 1
        actual_matrix = collections.Counter((r['phase'], r['config_id'], r.get('seed', r['params'].get('seed'))) for r in raw_index)
        check('frozen_12_plus_4_matrix', expected_matrix == actual_matrix)

    graphs_ok = params_ok = outputs_ok = metadata_ok = True
    paths = []
    training_ends, validation_starts = [], []
    for row in raw_index:
        pid = row['prompt_id']
        entries = paired.get(pid, [])
        if len(entries) != 1:
            graphs_ok = params_ok = metadata_ok = False
            continue
        submitted_at, body = entries[0]
        graph = body['prompt']
        if graph_without(graph, fields) != graph_without(original, fields):
            graphs_ok = False
        params = row['params']
        seed = row.get('seed', params.get('seed'))
        if params.get('seed') != seed or graph['7']['inputs']['seed'] != seed:
            params_ok = False
        if case == 'A1':
            target = expected.get(row['item_id'])
            if not target or seed != target['seed'] or params.get('prompt') != target['prompt'] or graph['4']['inputs']['text'] != target['prompt']:
                params_ok = False
        else:
            c = configs.get(row['config_id'])
            if not c or params.get('prompt') != experiment['fixed_prompt'] or graph['4']['inputs']['text'] != experiment['fixed_prompt'] or any(params.get(k) != c[k] or graph['7']['inputs'][k] != c[k] for k in ('steps', 'cfg')):
                params_ok = False
            if row['phase'] == 'training':
                training_ends.extend(e[0] for e in events[pid] if e[1] == 'execution_success')
            else:
                validation_starts.append(submitted_at)
        output = pathlib.Path(row['output_path'])
        if not output.is_absolute():
            output = run_dir / output
        if not output.is_file() or row.get('file_type', '').lower() != 'png' or output.stat().st_size != row.get('bytes'):
            outputs_ok = False
            continue
        paths.append(output)
        if png_graph(output) != graph:
            metadata_ok = False
    check('only_allowed_graph_fields_changed', graphs_ok)
    check('index_seed_prompt_parameters_match_actual_post', params_ok)
    check('output_files_and_declared_sizes', outputs_ok and len(paths) == expected_count and len(set(paths)) == expected_count)
    check('output_png_metadata_matches_actual_post', metadata_ok and len(paths) == expected_count)
    decoded = decode_images(paths) if len(paths) == expected_count else []
    check('all_png_decoded', None if decoded is None else len(decoded) == expected_count and all(x.get('ok') and x.get('width') == 512 and x.get('height') == 512 for x in decoded))

    # Count starts by exact submitted graph, allowing the frozen matrix to require
    # the same graph more than once (e.g. candidate equals baseline).
    graph_key = lambda graph: json.dumps(graph, sort_keys=True, separators=(',', ':'))
    expected_graphs = collections.Counter()
    for row in raw_index:
        entries = paired.get(row['prompt_id'], [])
        if len(entries) == 1:
            expected_graphs[graph_key(entries[0][1]['prompt'])] += 1
    actual_starts = collections.Counter()
    for handle, entries in paired.items():
        for _, body in entries:
            actual_starts[graph_key(body['prompt'])] += sum(e[1] == 'execution_start' for e in events[handle])
    complete = (checks['organizer_observer_complete'] and request_event_count == len(requests) and not orphan_starts and len(expected_graphs) > 0
                and sum(expected_graphs.values()) == expected_count
                and sum(len(v) for v in paired.values()) == len(requests)
                and all(any(e[1] == 'execution_start' for e in events[h]) for h in paired))
    duplicate = sum(max(0, count - expected_graphs[key]) for key, count in actual_starts.items() if key in expected_graphs) if complete else None
    checks['duplicate_executions'] = duplicate
    if duplicate is None:
        incomplete.append('duplicate_executions')
    elif duplicate:
        errors.append('duplicate_executions')

    if case == 'A2':
        candidate = run_dir / 'candidate-workflow.json'
        candidate_ok = candidate.is_file() and chosen is not None
        if candidate_ok:
            candidate_graph = read(candidate)
            candidate_ok = graph_without(candidate_graph, fields) == graph_without(original, fields) and all(candidate_graph['7']['inputs'][key] == chosen[key] for key in ('steps', 'cfg'))
        check('candidate_copy_matches_selection', candidate_ok)
        check('training_completed_before_validation_submission', len(training_ends) == 12 and len(validation_starts) == 4 and max(training_ends) < min(validation_starts))
        check('selection_evidence_and_contact_sheets_present', (run_dir / 'selection-evidence.md').is_file() and bool(list(run_dir.glob('training-contact.*'))) and bool(list(run_dir.glob('validation-contact.*'))))
    else:
        follow_start, follow_end = window.get('followup_start_utc'), window.get('followup_end_utc')
        follow_posts = sum(e['kind'] == 'prompt_request' and time(follow_start) <= at <= time(follow_end) for at, e in all_events) if follow_start and follow_end and start <= time(follow_start) <= time(follow_end) <= end else None
        checks['followup_posts'] = follow_posts
        if follow_posts is None:
            incomplete.append('followup_posts')
        elif follow_posts:
            errors.append('followup_posts')

    cached = sum(any(e[1] == 'execution_cached' and e[2].get('nodes') for e in events[h]) for h in handles)
    result = {'run_id': run_id, 'case': case, 'status': 'failed' if errors else ('incomplete' if incomplete else 'machine_checks_passed'), 'checks': checks,
              'errors': errors, 'unavailable': incomplete, 'counts': {'index_items': len(raw_index), 'window_posts': request_event_count, 'unique_response_handles': len(paired), 'png_decoded': sum(bool(x.get('ok')) for x in decoded) if decoded is not None else None, 'jobs_with_cache': cached if observation_complete else None},
              'source_sha256': {'index': digest(run_dir / 'result-index.json'), 'metrics': digest(run_dir / 'run-metrics.json'), 'before': digest(before), 'after': digest(after)},
              'normalization': 'Index seed may be taken from params when top-level seed is absent; no source files modified.', 'quality': 'pending_human_review' if case == 'A2' else 'not_applicable',
              'limits': ['Observer completeness depends on the independently recorded organizer window and backend audit health.', 'Model quality and selection rationale require independent review.']}
    return result


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        raise SystemExit('Usage: python audit-run.py RUN_DIRECTORY [OUTPUT_DIRECTORY]')
    directory = pathlib.Path(sys.argv[1])
    try:
        result = main(directory)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        result = {'run_id': directory.name, 'status': 'invalid_or_missing_evidence', 'error_type': type(error).__name__}
    if directory.name not in RUN_NAMES:
        raise SystemExit('Unknown run identifier')
    destination = pathlib.Path(sys.argv[2]) if len(sys.argv) == 3 else PUBLIC
    destination.mkdir(parents=True, exist_ok=True)
    (destination / (directory.name + '-validation.json')).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    raise SystemExit(0 if result['status'] == 'machine_checks_passed' else 1)
