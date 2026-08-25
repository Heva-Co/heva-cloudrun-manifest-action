# Cloud Run Manifest Action

Build a Cloud Run **Service** or **Job** manifest from GitHub Actions inputs,
validate it, and get warned when a value that should be a Secret Manager
reference is sitting in the manifest as plaintext.

It generates the manifest. It does not deploy — `gcloud run services replace`
stays in your workflow. That means the action needs no credentials and no
`id-token: write`: it runs *before* your auth step and never talks to GCP.

```yaml
- name: Build the manifest
  id: manifest
  uses: Heva-Co/heva-cloudrun-manifest-action@v1
  with:
    kind: service
    name: core-api-prd
    region: us-central1
    image: ${{ needs.build.outputs.image_tag }}
    service-account: ${{ vars.SERVICE_ACCOUNT_EMAIL }}
    environment: prd
    port: "8080"
    env-plain: |
      APP_ENV=prd
      LOG_LEVEL=info
    env-secrets: |
      JWT_SECRET=core-api-jwt-secret-prd
      DB_PASSWORD=core-api-db-password-prd
    output: ${{ runner.temp }}/service.yaml

- uses: google-github-actions/auth@v2
  with:
    project_id: ${{ vars.GCP_PROJECT_ID }}
    service_account: ${{ vars.GCP_DEPLOY_SERVICE_ACCOUNT }}
    workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
- uses: google-github-actions/setup-gcloud@v2

- run: gcloud run services replace "${{ steps.manifest.outputs.manifest-path }}" --region us-central1
```

Complete workflows: [`examples/service-caller.yml`](examples/service-caller.yml)
and [`examples/job-caller.yml`](examples/job-caller.yml).

## Why not just `envsubst`?

The common pattern is to commit a Knative manifest with `$VAR` placeholders and
render it with `envsubst` in the deploy job. It works, and then it accumulates
four problems.

**Drift between environments.** Once production needs Secret Manager references
where dev uses plaintext, you end up with `service.yaml` and `service.prd.yaml`
and a comment telling the next person to keep them in sync. They diverge — an env
var gets added to one and not the other, and production runs without it. Here
there is no second file: moving a credential to Secret Manager is moving one line
from `env-plain` to `env-secrets`.

**No validation.** `envsubst` substitutes every `$VAR` with no allowlist, so an
unexported variable becomes an empty string and the deploy ships misconfigured.
An empty `secretKeyRef.name` is accepted by the API and fails later at revision
startup, which is a long way from the typo that caused it. This action refuses to
emit a manifest with an unresolved placeholder or an empty load-bearing field, and
the error names the field.

**Quoting you have to get right by hand.** Cloud Run rejects a bool or an int in
`env[].value`, so workflows fill up with `MIN_SCALE: "'1'"` and
`NETWORK_INTERFACES: '''${{ vars.X }}'''` — quotes inside quotes inside quotes,
placed per variable and easy to get inconsistent between two environments. Every
env value is emitted as a quoted string here.

**Credentials in the build log.** Printing the rendered manifest is the normal way
to debug a deploy, and every value interpolated as a plain `env[].value` is right
there in the output. This action prints a redacted version by default and never
emits a secret value in any output.

## Inputs

Block inputs are the important part: a real service can have well over a hundred
env vars, which is fine as one multi-line input and unmanageable as individual
ones. Blank lines and `#` comments inside a block are ignored, so you can group a
long list.

### Required in practice

| Input | |
| --- | --- |
| `kind` | `service` (default) or `job` |
| `name` | Service/job name. Conventionally `<service>-<env>`. |
| `region` | e.g. `us-central1` |
| `image` | Fully-qualified container image |
| `service-account` | Runtime service account email |
| `environment` | `dev` \| `stg` \| `prd`. Drives the naming checks and the `auto` scan mode. |

### Container

`port` (service only; also the default probe port) · `cpu` · `memory` ·
`command` and `args` (one element per line, order preserved).

### Environment

```yaml
env-plain: |
  APP_ENV=prd
  FEATURE_FLAG=true          # emitted as the string "true"
  ALLOWED_ORIGINS=https://a.example.com,https://b.example.com

env-secrets: |
  JWT_SECRET=core-api-jwt-secret-prd          # version defaults to latest
  DB_PASSWORD=core-api-db-password-prd:7      # or pin one

secret-volumes: |
  jwt-key:/etc/app/jwt.pub=core-api-jwt-public-key-prd
```

`env-secrets` takes the Secret Manager id directly — no intermediate
`*_SECRET_NAME` placeholder to thread through your workflow. Only the first `=`
splits a line, so values containing `=` survive intact.

### Networking

`vpc-network` · `vpc-subnetwork` · `vpc-egress` (`all-traffic` |
`private-ranges-only`) · `vpc-tags` · `cloudsql-instances` (comma- or
newline-separated).

The `run.googleapis.com/network-interfaces` JSON is derived from the network and
subnetwork, so you never hand-escape it. Use short names when Cloud Run and the
VPC live in the same project, or fully-qualified paths for a Shared VPC.

### Service only

`traffic` (**required**, see below) · `ingress` · `invoker-iam-disabled` ·
`launch-stage` · `sandbox` · `cpu-throttling` · `session-affinity` ·
`custom-audiences` · `min-instances` · `max-instances` · `concurrency` ·
`timeout` · `startup-probe` · `liveness-probe` · `readiness-probe`.

Probes take a compact spec:

```yaml
startup-probe: path=/healthz,port=8080,initial-delay=10,timeout=10,period=10,failure-threshold=240
```

#### Traffic

```yaml
traffic: latest                     # this revision serves everything
traffic: hold=core-api-prd-00042-abc   # deploy without taking traffic
```

`hold=` is the **no-traffic deploy**: the named revision keeps 100%, and the new
one is exposed at 0% under `tag: candidate`. That lets a revision be built,
admitted and started — including mounting every secret — without being put in
front of users. The next deploy with `latest` restores normal routing on its own,
because a declarative `replace` overwrites the whole traffic block.

The revision name comes from the workflow, not from this action, which has no
credentials to look it up:

```yaml
- id: serving
  run: |
    rev=$(gcloud run services describe core-api-prd --region us-central1 \
      --format='value(status.latestReadyRevisionName)')
    echo "revision=$rev" >> "$GITHUB_OUTPUT"

- uses: Heva-Co/heva-cloudrun-manifest-action@v1
  with:
    traffic: hold=${{ steps.serving.outputs.revision }}
```

Two things about this input that are deliberate:

**It is required, with no default.** To the Cloud Run API an omitted `traffic`
block means all traffic to the latest revision, so defaulting it would let a
forgotten line take production traffic. Making it explicit costs one line and
removes that failure mode.

**There is no `none`.** A no-traffic deploy has to *name* the revision that keeps
serving — `replace` is declarative and overwrites the whole block, so a manifest
cannot say "leave traffic as it is". This is the same thing `gcloud run deploy
--no-traffic` does, which
[resolves the current revision client-side](https://cloud.google.com/sdk/gcloud/reference/run/deploy#--no-traffic)
before writing the spec. For the same reason `hold=` with an empty revision is an
error rather than a fallback: the instruction cannot be written, so the action
refuses instead of quietly taking the traffic.

Percentage splits — canary, or rolling back to an older revision — are not
modelled yet. Use `overlay` for a custom traffic block until they are.

### Job only

`parallelism` · `task-count` · `max-retries` (`0` is meaningful and preserved) ·
`timeout`.

### Escape hatches

`labels` · `annotations` (service-level) · `template-annotations`
(revision/task-level, overrides derived annotations) · `overlay` (raw YAML,
deep-merged last).

`overlay` exists so a Cloud Run field this action does not model yet never blocks
you on a release here:

```yaml
overlay: |
  spec:
    template:
      spec:
        nodeSelector:
          run.googleapis.com/accelerator: nvidia-l4
```

### Outputs

`manifest-path` · `name` · `kind` · `findings-count` · `findings` (JSON array of
`{name, detector, source}` — names and detector types only, never values).

## What it validates

1. No `$VAR` / `${VAR}` survives into the output. On `env[].value` only an
   exact-match placeholder counts, because a real credential can legitimately
   contain a `$` and a false positive here would block a correct deploy.
2. No empty `secretKeyRef.name`, `image`, `service-account` or `name`.
3. `name` and the referenced secrets agree with `environment`, so a staging deploy
   cannot quietly point at a production secret.
4. Service-only inputs are rejected on a Job and vice versa. Cloud Run ignores
   them silently, so they are refused here instead.
5. Every `env[].value` is emitted as a quoted string.
6. No duplicate env keys, within a block or across `env-plain` and `env-secrets`.

Every message names the field, and all problems are reported at once rather than
one per run.

## Secret scanning

Two independent signals, because they catch different things:

**Name heuristic** (in-process). An `env-plain` key matching
`_SECRET|_TOKEN|_PASSWORD|_PASS|_API_KEY|_PRIVATE_KEY|_CREDENTIALS|_AUTH|_KEY`.
`NEXT_PUBLIC_*` is exempt — a publishable key is compiled into the browser bundle
by design, and flagging it would train people to ignore the check. This catches
short, low-entropy secrets an entropy detector never will.

**[Yelp's detect-secrets](https://github.com/Yelp/detect-secrets)** (entropy over
the real value). This catches a high-entropy value behind an innocuous name.
It respects your `.secrets.baseline` and inline `# pragma: allowlist secret`.

| `secret-scan` | Behaviour |
| --- | --- |
| `auto` (default) | warn on `dev`/`stg`, fail on `prd` |
| `warn` | always warn, never fail |
| `error` | always fail |
| `off` | skip both signals |

Findings report the env var **name** and the detector. detect-secrets reports a
hash rather than plaintext, and the line-number mapping turns a hit into a name,
so no code path can emit a value.

## Development

```bash
pnpm install
pnpm test                 # unit suite
./scripts/local-check.sh  # everything CI runs
./scripts/render-local.sh tests/fixtures/core-api.inputs.yml /tmp/out.yaml
```

`render-local.sh` emulates the runner by setting `INPUT_*` and invoking the built
bundle, so no `act` is needed. It covers the generator; it does not cover the
wiring between composite steps, which `self-test.yml` does.

`detect-secrets` is optional locally: without it the entropy tests skip **with a
visible warning**. CI sets `HEVA_REQUIRE_DETECT_SECRETS=1`, which turns that skip
into a failure — a silently skipped scan suite is a false green on the one check
meant to keep credentials out of manifests.

```bash
brew install detect-secrets    # or: pip install detect-secrets
brew install shellcheck actionlint   # optional, checked when present
```

`dist/` is committed and is what Actions executes. Run `pnpm build` after any
`src/` change; CI fails on drift.

There is no HTTP client in the bundle. `@actions/core` was replaced by
[`src/core.ts`](src/core.ts) — the small part of the runner protocol this action
uses — because `@actions/core` pulls in `undici` for OIDC, which was most of the
bundle and has no business being in an action that must never make a network
call. `tests/core.test.ts` covers the protocol, including the detail that the
runner does not translate hyphens, so `service-account` arrives as
`INPUT_SERVICE-ACCOUNT`.

## Testing

| Level | What only it can catch |
| --- | --- |
| `pnpm test` | Rendering, validation, scanning, redaction. Ten golden fixtures covering the shapes a real deployment hits, ten negative fixtures each asserting the *reason* it was rejected, and `parity.test.ts`. |
| `self-test.yml` | `action.yml`'s wiring — input names, defaults, and the fact that composite steps do not inherit env from each other. Includes a `negative` job asserting the action *fails*, a `scan-modes` job, and an `env-inheritance` job. |
| `gcp-accept.yml` | Whether Cloud Run accepts the shape. Dispatch-only; see its header for the IAM it needs. |

`parity.test.ts` renders a hand-authored legacy-style manifest with `envsubst` and
asserts the generated one reaches the same semantics — same env var set, same
secret references, same annotations, same limits. The templates in
[`tests/legacy/`](tests/legacy/) are written by hand in the old style on purpose;
generating them would make the test compare the generator against itself.

## Conventions this action assumes

Some checks encode conventions rather than Cloud Run requirements:

- Workloads are named `<service>-<env>` with `env` one of `dev`, `stg`, `prd`.
- Secret ids carry the same `-<env>` suffix, except shared secrets, which carry no
  suffix and are accepted in any environment.

If those do not match your naming, `secret-scan-allow` exempts individual env
vars, or set `environment` to whichever token your names actually use.

## License

[MIT](LICENSE).
