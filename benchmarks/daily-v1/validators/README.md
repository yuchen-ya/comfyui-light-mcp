# Daily v1 independent checks

These checks only read files and print JSON. They never submit, retry or schedule work. Run with Node 22 on Windows:

```powershell
node benchmarks/daily-v1/validators/validate.mjs production C:/local/run/manifest.json
node benchmarks/daily-v1/validators/validate.mjs catalog C:/local/catalog/manifest.json
node --test benchmarks/daily-v1/validators/validate-check.mjs
```

All paths inside a manifest, including paths in its index, are relative to the **manifest directory**, or absolute. Keep manifests, original submitted graphs, observer records, raw outputs, and A4 ground truth outside the tested agent's inputs; redact private paths and content before publishing. Exit codes are 0 for checks passed, 1 for a failed or unavailable check, and 2 for malformed or inaccessible evidence. A passing check is not by itself a complete benchmark acceptance.
The self-test uses temporary synthetic files; its production decode test runs on Windows and is skipped elsewhere.

## Production (A1/A2)

The organizer prepares the manifest and freezes the before template and expected parameters independently of the agent's results:

```json
{
  "template_before": "template-before.json",
  "template_after": "template-after.json",
  "expected_count": 20,
  "allowed_fields": ["/3/inputs/seed", "/6/inputs/text"],
  "expected_items": [{
    "item_id": "item-01", "params": {"prompt": "example"}, "seed": 42,
    "graph_values": {"/3/inputs/seed": 42, "/6/inputs/text": "example"}
  }],
  "index": "index.json", "observer": "observer.json", "require_followup": true
}
```

The shortened example shows one item; include all `expected_count` items (16, 20, 50 or 100), including all A2 training and validation items. `graph_values` must include every allowed pointer for every item, including unchanged values; pointers address scalar fields in the actual submitted graph. `params` must include the task's actual parameters and be consistent with the independently prepared graph values. Input and after templates are byte-compared; a saved before copy is required. A submitted graph must be captured from the actual request, not reconstructed from the index. Index is a JSON array with one object per item:

For A2, add `"case_id":"A2"`, `"experiment":"experiment.json"` (the frozen experiment file), and `"selected_config_id":"cfg-1"` to the manifest. Each expected item also has `phase` (`training`, `validation_baseline`, or `validation_candidate`) and `config_id`; its `params` has `steps`, `cfg`, and `prompt`. The checker compares the 12 training and four validation rows against that file, including independent validation seeds. The organizer must map all applicable parameters and seed to actual graph pointers. This matrix check does not establish when or why the candidate was selected, timing, or quality.

```json
[{"item_id":"item-01", "params":{"prompt":"example"}, "seed":42,
  "prompt_id":"handle-01", "submitted_graph":"graphs/item-01.json",
  "output_path":"outputs/item-01.png", "file_type":"png", "file_size":123,
  "status":"succeeded"}]
```

This minimal contract supports one output file per item; tasks with multiple outputs require separate independent review. The verifier checks ID coverage, actual graph against all expected allowed values and the original graph, index parameters, unique handles and paths, file size, file extension, and actual decode/type. On Windows it uses the platform GDI+ decoder for PNG and JPEG, draws the entire image, and checks the decoded format. Unsupported formats/platforms or an unavailable decoder are reported as unavailable and cannot pass. A codec may tolerate some damaged files; visual/quality review remains separate.

An independent observer record must cover the entire submission/execution interval, including dropped responses, and map every observed execution start to the business ID and prompt ID:

```json
{"complete":true, "execution_starts":[{"item_id":"item-01","prompt_id":"handle-01"}],
 "followup_complete":true, "followup_post_count":0}
```

`complete` is an organizer assertion based on the observer's actual coverage, not a value inferred from history, result files or succeeded status. Missing/incomplete/unmapped observations yield `duplicate_executions: null` and do not pass; starts are counted per item. Set `require_followup` for A1 and assert `followup_complete` only when the follow-up interval's POSTs were fully observed. The script cannot independently establish observer completeness, authenticity, or that captured graphs belong to the stated POST; retain raw evidence for review. A2 selection, baseline/validation seed design, timing, and blind quality assessment require separate review.

## Catalog (A4)

Manifest: `{"ground_truth":"ground-truth.json", "catalog":"catalog.json"}`. The private ground truth is an array of exactly 20 entries, each with `old_path`, `sha256` (original bytes), `classification`, `group`, and `disposition`. Classification and group must encode byte duplicates, content-equivalent exports, variants, invalid items, and API/UI relationships using the organizer's frozen labels. These fields may be objects to represent overlapping relationships; comparison is by content. Disposition encodes the required archive/quarantine placement. Do not expose this file to the tested agent.

The catalog is an array with one entry per original path and fields `old_path`, `new_path`, `classification`, `group`, `disposition`, `purpose`, `inputs`, `outputs`, `dependencies`, `parameters`, `source`, and `validation_status`. Validation status is `unverified`, `static_validated`, or `run_validated`. The last two require an existing `static_evidence` or `run_evidence` file path respectively. Every original must map to a distinct retained file whose bytes match the frozen SHA-256; classification, grouping and disposition must match ground truth. The evidence files and disposition labels are references, not proof of actual execution or location: review their contents and actual placement independently. Check discovery and the required real runs separately. This verifier does not turn static checks into execution claims.
