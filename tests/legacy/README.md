# Legacy-style reference manifests

Hand-authored templates in the shape this action replaces: a Knative manifest
committed to a repo with `$VAR` placeholders, rendered by `envsubst` in the
deploy workflow.

They are written **deliberately in the old style**, including its inconsistencies:

- `env` in insertion order rather than sorted
- `metadata.generation`, a copy-paste artefact from `gcloud run services describe`
- `ingress` without a matching `ingress-status`
- `key:` before `name:` inside one `secretKeyRef` and after it in another
- values left unquoted, relying on the workflow to supply the quotes
- a two-space `containers:` list in one file and four-space in another

`parity.test.ts` renders these with `envsubst` and asserts the generated manifest
reaches the same semantics. That is only meaningful because these files are
authored by hand, not produced by the generator — a generated "before" would make
the test compare the generator against itself.

All identifiers are fictional.
