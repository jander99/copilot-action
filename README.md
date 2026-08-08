# AI Review Action

AI Review Action runs repository reviews through either the OpenCode CLI or the Claude Code CLI (selected via the `tool` input) using provider API keys supplied by your workflow. It supports one or many models and prompts, deterministic merging of multiple reviews into one canonical document, cost and token reporting, PR comments, non-PR check runs, user-composed OpenCode configuration, and opt-in debug capture.

## Prerequisites

- A **Linux x64** runner. macOS, Windows, Linux arm64, and other platforms are not supported.
- `actions/checkout@v6` with `fetch-depth: 0` so the model can inspect the complete Git history and base ref.
- `git`, `bash`, `tar`, `curl`, and Node/npm tooling on `PATH`. `ubuntu-latest` provides these; Node 22+ is recommended when installing skills with `npx`.
- The chosen reviewer CLI installed as a separate workflow step before this action:
  - For `tool: opencode` (default): install OpenCode with the standalone [`setup-opencode`](#opencode-installation) action and pin its SHA-256 checksum.
  - For `tool: claude`: install the Claude Code CLI (e.g., via `@anthropic-ai/claude-code`'s installer or a custom step). Standard Anthropic users expose `ANTHROPIC_API_KEY`; users routing through an Anthropic-compatible endpoint (e.g. Minimax) expose `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` instead (see `ANTHROPIC_API_KEY handling` below).
- At least one provider credential exposed as an environment variable.
- A prompt using the `file:` or `text:` prefix.

## Quickstart

The repository includes a minimal prompt at `examples/prompts/code-review.md`. Configure `ANTHROPIC_API_KEY` as an Actions secret, then add this workflow. It uses the [vetted OpenCode 1.18.4 checksum](#vetted-opencode-versions):

```yaml
name: AI Review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      # For production, replace v1 with a full ai-review-action commit SHA.
      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      # Pin this to the same full commit SHA in production.
      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The examples use `@v1` for readability. In production, resolve the `v1` release or tag to its full commit SHA on the repository's Releases or Commits page and use that SHA for both action references, for example `jander99/ai-review-action@<full-commit-sha>`.

### `setup-opencode` inputs

| Input | Required | Default | Description |
|---|---:|---|---|
| `version` | No | `1.18.4` | OpenCode version to install. |
| `checksum` | **Yes** | None | SHA-256 of the selected OpenCode tarball. Use a value from [Vetted OpenCode versions](#vetted-opencode-versions). |
| `install-dir` | No | `~/.opencode` | Directory where the `opencode` binary is placed. |

## How it works

```text
┌──────────────────────────────────────────────┐
│ 1. Workflow                                 │
│ checkout, provider secrets, prompts/config  │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ 2. setup-opencode                           │
│ download pinned Linux-x64 archive           │
│ → verify workflow-supplied SHA-256 → install│
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ 3. AI Review Action (single JS bundle)      │
│ run-reviews → validate-review               │
│ → post-comment (pull_request)               │
│ → post-check-run (other events)             │
│ → post-error-comment / error check run      │
└──────────────────────────────────────────────┘
```

1. The workflow owns checkout, credentials, prompts, skills, MCPs, plugins, and optional user configuration.
2. `setup-opencode` (or an equivalent Claude Code installer step) installs the exact requested CLI version only after the supplied archive checksum matches.
3. The root action (`packages/root-action`) is a single JavaScript bundle. It drives `run-reviews`, `validate-review`, `post-comment`, `post-check-run`, and `post-error-comment` programmatically, so the action works when invoked as `owner/repo@ref` (not just from a checked-out workspace). The packages remain available as standalone sub-actions for callers who want fine-grained composition.

The action does not materialize a diff. It injects event and ref context into the action-owned agent definition, and the model uses Git to decide what to review.

## Inputs

These are all inputs accepted by the root `jander99/ai-review-action` action.

| Input | Required | Default | Description |
|---|---:|---|---|
| `tool` | No | `opencode` | Reviewer CLI to invoke. `opencode` runs the OpenCode CLI; `claude` runs the Claude Code CLI. The `model` input must be in `provider/model` format; for `claude` the provider portion is stripped before being passed as `--model`. |
| `opencode-version` | No | `1.18.4` | Exact version expected from `opencode --version`. Only consulted when `tool: opencode`. Installation remains the workflow's responsibility. |
| `claude-version` | No | Empty | Expected Claude Code CLI version. Only consulted when `tool: claude`. When empty, the action only verifies the `claude` binary is on PATH without pinning a specific version. |
| `debug` | No | `false` | Capture reviewer CLI stdout/stderr, apply best-effort redaction, gzip the files, and upload the `ai-review-debug` artifact for 7 days. |
| `github-token` | No | `${{ github.token }}` | Token used to publish a PR comment or check run. Its permissions must match the event. |
| `model` | No | `anthropic/claude-sonnet-4.6` | Single model in `provider/model` form. For `tool: opencode` the full string is passed to `--model`; for `tool: claude` the provider portion is stripped. Used when `models` is empty. |
| `models` | No | Empty | Comma-separated models. When set, this overrides `model`. Same `provider/model` formatting rules apply per `tool`. |
| `prompts` | **Yes** | None | Comma-separated prompt sources. Each entry must begin with `file:` or `text:`. |
| `opencode-config` | No | None | Path to a user-provided `opencode.json` or `opencode.jsonc` to merge into the isolated action configuration. Only consulted when `tool: opencode`; ignored for `tool: claude`. |
| `permission` | No | [Explicit per-tool defaults](#default-tool-permissions) | JSON object replacing the OpenCode permission block. Only consulted when `tool: opencode`; Claude Code uses hardcoded `--allowedTools` instead. |
| `timeout-minutes` | No | `30` | Timeout for each reviewer invocation. Must be a positive integer. |
| `fail-on-error` | No | `false` | Fail the step when any review operation fails. Setup and validation failures always fail. |
| `post-comment` | No | `true` | Publish on `pull_request` events. Set to `false` to consume outputs without commenting. |
| `post-check-run` | No | `true` | Publish on non-PR events. Set to `false` to consume outputs without creating a check run. |
| `max-comment-chars` | No | `65000` | Maximum PR comment length before truncation. |
| `check-name` | No | `ai-review` | Name of the check run created for non-PR events. |
| `check-conclusion` | No | `neutral` | Check conclusion: `action_required`, `cancelled`, `failure`, `neutral`, `success`, `skipped`, `stale`, or `timed_out`. |
| `check-details-url` | No | `https://github.com` | URL linked from a non-PR check run. |

### Default tool permissions

Unless `permission` is supplied, the generated OpenCode configuration uses:

```json
{
  "read": "allow",
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "webfetch": "allow",
  "edit": "ask",
  "question": "ask",
  "doom_loop": "ask",
  "bash": "allow"
}
```

OpenCode does not currently provide reliable sub-command allow-lists. `bash: allow` is therefore broad runner access, not a sandbox boundary.

## Outputs

| Output | Description |
|---|---|
| `review` | Canonical review document. When a single review invocation produces a valid document, that document is returned. When multiple invocations succeed, the documents are deterministically merged into one canonical document. Empty when no invocation produced a valid document, or when valid invocations merged past the contract maximum (see `failure-reason`). |
| `review-output-path` | Runner-local path to the authoritative review markdown file written by the action from a validated model response. |
| `config-json` | OpenCode config JSON for the validator invocation (no agent review prompts, no path leakage, no user-supplied secrets). |
| `comment-url` | URL of the posted PR comment (pull_request events). Falls back to the error-comment URL when the normal post is skipped. |
| `check-run-url` | URL of the created check run (non-PR events). Falls back to the error-check-run URL when the normal check run is skipped. |
| `models-used` | Comma-separated list of models that completed successfully. |
| `effective-model` | The effective first model (provider/model format) selected from `model` or `models`. |
| `cost` | Reviewer-only cost in USD. The validator cost is reported separately under `validate-cost`; the sum is exposed as `total-cost`. |
| `validate-cost` | Validator cost in USD. |
| `total-cost` | Reviewer + validator cost in USD. |
| `cost-by-model` | JSON object containing cost by model (reviewer only). |
| `tokens` | JSON object containing total input and output tokens (reviewer only). |
| `validate-tokens` | JSON object with input/output tokens for the validator call. |
| `tokens-by-model` | JSON object containing token usage by model (reviewer only). |
| `debug-artifact-path` | Runner directory containing redacted, gzipped debug files when `debug: true`. The workflow is responsible for uploading this directory (see [Debug mode](#debug-mode) below); the root action only exposes the path. |
| `validate-status` | Status from the structural validator: `valid` or `invalid`. Empty when validation was skipped. |
| `validate-reason` | Human-readable reason when the validator rejects the review. Empty when validation was skipped (e.g. all review invocations failed before producing a document); see `failure-reason` for the canonical fallback message covering both reviewer and validator failures. |
| `failure-reason` | Canonical failure message (empty on success). Covers BOTH reviewer failures AND validator failures. When both fail, the reviewer message wins because the validator typically was skipped. |

## Sub-actions

The repository is an Nx monorepo. The root action is a single JavaScript bundle; the packages under `packages/*` are also exposed as standalone sub-actions for callers that want fine-grained composition.

| Sub-action | Path | Purpose |
|---|---|---|
| `setup-opencode` | `packages/setup-opencode` | Install a pinned OpenCode release after verifying its SHA-256 checksum. |
| `run-reviews` | `packages/run-reviews` | Run the review and validation pipeline; write the canonical document. |
| `validate-review` | `packages/validate-review` | Run the structural validator on a review file. |
| `post-comment` | `packages/post-comment` | Post a PR comment from a review document. |
| `post-check-run` | `packages/post-check-run` | Create a check run from a review document. |
| `post-error-comment` | `packages/post-error-comment` | Post a short error comment when the validator rejects a review. |

A consumer can pin a sub-action exactly like the root action:

```yaml
- uses: jander99/ai-review-action/packages/run-reviews@v1
  with:
    prompts: file:examples/prompts/code-review.md
    opencode-config: examples/opencode.json
```

## Sample workflows

The samples below cover the main supported workflows. They assume:

- The vetted `1.18.4` checksum is embedded directly in each setup step.
- Prompt and configuration files are available under this repository's `examples/` directory; copy them when adapting a sample elsewhere.
- Referenced provider keys are configured as Actions secrets.
- `@v1` is replaced with one full action commit SHA for production use.

### Quickstart (with standalone setup step)

Run one prompt with one Anthropic model and publish the result as a PR comment.

```yaml
name: AI Review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Default workflow permissions

Omit an explicit workflow `permissions` block and inherit the repository or organization token defaults; comment posting may be unavailable.

```yaml
name: AI Review (default token permissions)
on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Multi-model with deterministic merge

Run every prompt against both models; the action deterministically merges the successful results into one canonical document (no separate synthesis pass).

```yaml
name: AI Review (multi-model)
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6, openai/gpt-4o"
          prompts: "file:examples/prompts/code-review.md, file:examples/prompts/security-review.md"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### User-provided `opencode.json`

Merge the trusted `examples/opencode.json` configuration while preserving action-required agent, model, provider, and permission settings. The example uses OpenCode's `{env:GITHUB_TOKEN}` interpolation; the action does not expand `${VAR}` placeholders in user configuration.

```yaml
name: AI Review (custom OpenCode config)
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          opencode-config: examples/opencode.json
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

### With skills and MCPs

Install a trusted skill before review; MCP servers and plugins can be declared in the file selected by `opencode-config`.

```yaml
name: AI Review (skills)
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - name: Install skills
        run: npx -y skills@1 add vercel-labs/agent-skills --agent opencode --yes

      - uses: jander99/ai-review-action@v1
        with:
          models: "anthropic/claude-sonnet-4.6"
          opencode-config: examples/opencode.json
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

### Custom provider (MiniMax)

Use the built-in MiniMax provider definition by exposing `MINIMAX_API_KEY`.

```yaml
name: AI Review (MiniMax)
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          model: minimax/minimax-m3
          prompts: file:examples/prompts/code-review.md
        env:
          MINIMAX_API_KEY: ${{ secrets.MINIMAX_API_KEY }}
```

### Debug mode

Upload redacted and gzipped OpenCode JSONL/stderr streams as an `ai-review-debug` workflow artifact.

```yaml
name: AI Review (debug)
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
          debug: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Claude Code runtime

Run the same pipeline through the Claude Code CLI by selecting `tool: claude`. The `model` input stays in `provider/model` format; the dispatcher strips the `provider/` prefix before passing the model id to Claude Code's `--model` flag.

```yaml
name: AI Review (Claude Code)
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      # Install the Claude Code CLI in a workflow step the caller
      # controls. The action itself only verifies the `claude`
      # binary is on PATH (or matches `claude-version` when set).
      - run: npm install -g @anthropic-ai/claude-code

      - uses: jander99/ai-review-action@v1
        with:
          tool: claude
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/code-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Notes on the Claude Code runtime:

- The `model` input MUST be in `provider/model` form. The provider prefix is stripped before being passed to `--model` so the CLI receives e.g. `claude-sonnet-4.6`.
- `opencode-config`, `permission`, and `opencode-version` are ignored when `tool: claude`. Claude Code uses hardcoded `--allowedTools` for read-only inspection plus the same read-only git subset OpenCode allows.
- Set `claude-version` to pin a specific release; leave it empty to only verify the `claude` binary is present.
- The validator is opencode-only and currently rejects Claude Code reviews with a `config-json input is required` message. Treat the validator output as informational until a future change lets `tool: claude` skip the validator cleanly.

### Push to the default branch

Publish the result as a check run named `ai-review` because no pull request is associated with the event.

```yaml
name: AI Review (default branch)
on:
  push:
    branches: [main]

permissions:
  contents: read
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: jander99/ai-review-action/packages/setup-opencode@v1
        with:
          version: 1.18.4
          checksum: bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174

      - uses: jander99/ai-review-action@v1
        with:
          model: anthropic/claude-sonnet-4.6
          prompts: file:examples/prompts/repo-review.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Supported providers

Credentials are environment variables, not action inputs. Native providers are discovered by OpenCode (for `tool: opencode`) or routed through the Claude Code CLI (for `tool: claude`). The action adds built-in configuration for the listed custom providers when their credential environment is present.

| Provider | Integration | Environment variables |
|---|---|---|
| Anthropic | OpenCode native (and Claude Code CLI for `tool: claude`) | `ANTHROPIC_API_KEY` |
| OpenAI | OpenCode native | `OPENAI_API_KEY` |
| Google Gemini | OpenCode native | `GEMINI_API_KEY` |
| GitHub Copilot through OpenCode | OpenCode native | `GITHUB_TOKEN` with the required Copilot access |
| MiniMax | Built-in custom provider | `MINIMAX_API_KEY` |
| Kimi / Moonshot | Built-in custom provider | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
| AWS Bedrock | Built-in custom provider | `AWS_BEARER_TOKEN_BEDROCK`, or standard AWS variables such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, or `AWS_WEB_IDENTITY_TOKEN_FILE`; region from `AWS_REGION`/`AWS_DEFAULT_REGION` |
| Google Vertex Anthropic | Built-in custom provider | `GOOGLE_APPLICATION_CREDENTIALS`; project from `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, or `GCP_PROJECT`; location from `GOOGLE_CLOUD_LOCATION` |
| Other providers | User-defined through `opencode-config` (opencode only) | Any `{env:USER_DEFINED_VAR}` referenced by that configuration |

For built-in providers, the merged configuration references secrets with OpenCode's `{env:VAR}` syntax rather than embedding key values. For `tool: claude`, the action passes `ANTHROPIC_*` environment variables through unchanged so the caller can also route through `ANTHROPIC_BASE_URL` to any Anthropic-compatible endpoint.

### `ANTHROPIC_API_KEY` handling for `tool: claude`

The Claude Code CLI's authentication behavior depends on two env vars: `ANTHROPIC_API_KEY` (the standard key) and `ANTHROPIC_BASE_URL` (a third-party routing signal). When `ANTHROPIC_BASE_URL` is set, the action force-empties `ANTHROPIC_API_KEY` so Claude Code's OAuth-fallback is suppressed and the endpoint routes via `ANTHROPIC_AUTH_TOKEN` (Bearer auth). When `ANTHROPIC_BASE_URL` is unset, the action passes the user's real `ANTHROPIC_API_KEY` through untouched so standard Anthropic users get the expected auth flow.

| `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY` forwarded as | Why |
|---|---|---|
| unset (or empty string) | `process.env.ANTHROPIC_API_KEY` (or `''` if not set) | Standard Anthropic users. The CLI uses the supplied key normally. |
| set (e.g. `https://api.minimax.io/anthropic`) | `''` (empty string) | Third-party Anthropic-compatible endpoints. The empty string suppresses Claude Code's OAuth fallback; auth comes via `ANTHROPIC_AUTH_TOKEN` (Bearer). |

This is conditional on the **presence** of `ANTHROPIC_BASE_URL`, not on its actual value. Setting `ANTHROPIC_BASE_URL` to any non-empty string flips the action into third-party-routing mode. Standard Anthropic users leave `ANTHROPIC_BASE_URL` unset and the action forwards their real `ANTHROPIC_API_KEY` unchanged.

## OpenCode installation

`setup-opencode` is a standalone action and must run before the root action. The root action's `opencode-version` input only asserts the version already installed on `PATH`.

The installation contract is deliberately explicit:

1. The workflow selects an OpenCode version and supplies the SHA-256 checksum.
2. `setup-opencode` supports **Linux x64 only** and downloads `opencode-linux-x64.tar.gz` from that exact GitHub release.
3. The action rejects a checksum that is not 64 hexadecimal characters.
4. It hashes the downloaded archive and stops before extraction if the value differs.
5. After verification, it extracts the binary, installs it atomically, and adds the install directory to `PATH`.

### Vetted OpenCode versions

Use the checksum below for the exact release asset named in the same row. Every workflow sample in this README pins this value directly.

| OpenCode version | Asset | SHA-256 |
|---|---|---|
| `1.18.4` | `opencode-linux-x64.tar.gz` | `bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174` |

This value was computed from the [`v1.18.4` Linux x64 release asset](https://github.com/anomalyco/opencode/releases/download/v1.18.4/opencode-linux-x64.tar.gz). An independent calculation of that exact archive must match the published value. Do not reuse a checksum for another version, platform, filename, or rebuilt archive.

The action itself should also be pinned by full commit SHA in production. The OpenCode archive checksum protects the downloaded runtime; the action commit SHA protects the installer and review logic.

## Permission model

The action sets a deny-list `OPENCODE_PERMISSION` JSON before spawning the OpenCode CLI. The deny list covers the built-in filesystem and shell tools (`bash`, `read`, `glob`, `grep`, `list`, `webfetch`, `edit`, `write`) plus interaction controls (`question`, `doom_loop`). The action does NOT deny the built-in sub-agent tools (`task`, `todowrite`) — by design, so users adding MCP servers and plugins to their OpenCode config can opt into those tool capabilities without modifying the action.

In OpenCode's permission resolver, **tool names not listed in the JSON default to allowed**. So MCP server tools (e.g. `codegraph_explore`, `codegraph_search`) and any user-added plugin tools work out of the box. The baked-in review prompt forbids the model from using `task`/`todowrite` under non-agentic invocation — see `REVIEW_AGENT_PROMPT_TEMPLATE` — but the permission layer stays extensible.

To restrict an MCP tool that the model should not reach, the consumer's `opencode-config` input can override `OPENCODE_PERMISSION` with explicit allow/deny entries for those tool names.

For `tool: claude`, the action hardcodes `--dangerously-skip-permissions` and an `--allowedTools` allow-list that mirrors the read-only git subset above (`Read`, `Glob`, `Grep`, `Bash(git diff *)`, `Bash(git show *)`, `Bash(git log *)`, `Bash(git rev-parse *)`, plus `query` for Claude Code's internal structured-prompt tool). The user-supplied `permission` input is ignored for this runtime.

## Security

See [SECURITY.md](SECURITY.md) for the trust model, permissions, supply-chain guidance, and operational limitations.

## License

MIT
