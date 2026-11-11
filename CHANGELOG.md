# Changelog

## 0.3.0-rc.2

- Single-run `params` requests now honor `max_attempts` and `continue_on_error`, using the same retry and idempotency rules as batch requests. Replays check existing keys before validating parameters for new work, so manifest changes report a fingerprint conflict consistently.
- ComfyUI endpoints are validated before startup. Embedded credentials, query parameters and fragments are rejected without echoing their values; HTTP(S) proxy path prefixes remain supported.
- English and Chinese setup guides now cover workflow hot reload, read-only preflight, local package installation, result collection and database recovery.
- Read-only preflight accepts the random seed default (`special: "seed"`, `default: -1`) while continuing to check the resolved seed against the backend input range.
- Magpie setup instructions explain version-pinned startup, explicit local directories and application defaults. Registry discovery remains unavailable until the npm package and Registry entry are published.
