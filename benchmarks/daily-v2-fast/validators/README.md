# Daily v2 fast run audit

After the organizer closes a run, invoke the validator with its directory. Absolute paths work from any current directory:

```text
python <repository>/benchmarks/daily-v2-fast/validators/audit-run.py <run-directory>
```

It uses Python's standard library and Windows GDI+ for PNG decoding. It reads the repository's frozen fixtures, run input and pre-task copy, result index, metrics, and backend audit; it does not submit, poll, repair, or modify them. It writes `evidence/redacted/<run_id>-validation.json` under `benchmarks/daily-v2-fast`. An optional second argument selects another output directory, for example during synthetic tests.

The organizer supplies `audit-window.json` with UTC `start_utc`, `end_utc`, the private absolute `audit_log`, `observer_complete`, `server_was_alive`, `failure_marker_detected`, and the pre-dispatch `workflow_before_sha256` and `workflow_input_sha256`. A1 additionally requires `followup_start_utc` and `followup_end_utc` within the task window. The organizer must independently establish that backend instrumentation was complete and no unrelated execution overlaps the window. Do not infer completeness merely from matching result counts.

The result index must be a JSON array. Each item needs `item_id`, `params`, `prompt_id`, `output_path`, `file_type`, and `bytes`; top-level `seed` may be omitted when `params.seed` exists. A2 also needs `phase` and `config_id`; its selected configuration is `selected_config_id` in `run-metrics.json`. A2 needs `candidate-workflow.json`, training and validation contact sheets, and `selection-evidence.md`. The exact supported run IDs are listed in the script.

The verifier checks the frozen matrix, submitted graphs, observed response and execution events, output decoding and embedded prompt metadata. Exit 0 means the listed machine checks passed; exit 1 means failure, missing evidence, or malformed input. Missing observer coverage produces a null duplicate count. The observer window cannot prove executions outside its boundaries; retain raw evidence locally. Contact sheets and selection evidence are checked for existence only; independent blinded human quality review remains pending. Cache counts do not establish equivalent execution work.
