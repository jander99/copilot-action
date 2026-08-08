import * as core from '@actions/core';
import { runReviews, type RunReviewsOptions, type RunReviewsResult } from './main';
import type { ReviewTool } from './opencode';
import { DEFAULT_PERMISSION } from './permissions';
import type { Permission } from './types';

const DEFAULT_OPENCODE_VERSION = '1.18.4';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_TIMEOUT_MINUTES = 30;

function readPermissionInput(input: string): Permission {
  if (!input) {
    return { ...DEFAULT_PERMISSION };
  }
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('permission must be a JSON object');
  }
  return parsed as Permission;
}

/**
 * Resolve the `tool` input to a known runtime identifier. The
 * `tool` input defaults to `'opencode'` for back-compat; any other
 * value is rejected up-front so a typo surfaces as a clear error
 * rather than silently dispatching to the wrong CLI.
 */
function readToolInput(input: string): ReviewTool {
  const raw = (input || 'opencode').trim().toLowerCase();
  if (raw === 'opencode' || raw === 'claude') {
    return raw;
  }
  throw new Error(
    `tool input must be 'opencode' or 'claude'; received '${input || '<empty>'}'`,
  );
}

function buildOptionsFromCore(): RunReviewsOptions {
  return {
    tool: readToolInput(core.getInput('tool')),
    opencodeVersion: core.getInput('opencode-version') || DEFAULT_OPENCODE_VERSION,
    claudeVersion: core.getInput('claude-version') || undefined,
    debug: core.getBooleanInput('debug'),
    model: core.getInput('model') || DEFAULT_MODEL,
    modelsInput: core.getInput('models'),
    failOnError: core.getBooleanInput('fail-on-error'),
    timeoutMinutes: Number.parseInt(core.getInput('timeout-minutes') || `${DEFAULT_TIMEOUT_MINUTES}`, 10),
    prompts: core.getInput('prompts'),
    permission: readPermissionInput(core.getInput('permission')),
    userConfig: core.getInput('opencode-config') || undefined,
    githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN,
  };
}

function writeOutputs(result: RunReviewsResult): void {
  core.setOutput('review', result.review);
  core.setOutput('review-output-path', result.reviewOutputPath);
  core.setOutput('models-used', result.modelsUsed);
  core.setOutput('cost', result.cost);
  core.setOutput('cost-by-model', JSON.stringify(result.costByModel));
  core.setOutput('tokens', JSON.stringify(result.tokens));
  core.setOutput('tokens-by-model', JSON.stringify(result.tokensByModel));
  core.setOutput('effective-model', result.effectiveModel);
  core.setOutput('config-json', result.configJson);
  if (result.debugArtifactPath) {
    core.setOutput('debug-artifact-path', result.debugArtifactPath);
  }
  // `failure-reason` is the single canonical failure-reason output
  // (Phase-3 reduced naming to one). Reviewers downstream read this
  // output regardless of which step produced the failure.
  if (result.failureReason) {
    core.setOutput('failure-reason', result.failureReason);
    core.setFailed(result.failureReason);
  } else {
    core.setOutput('failure-reason', '');
  }
}

async function run(): Promise<void> {
  const options = buildOptionsFromCore();
  const result = await runReviews(options);
  writeOutputs(result);
}

// Standalone action entrypoint. This file is the leaf action's
// `dist/main.cjs` entrypoint; it MUST stay gated on `require.main ===
// module` so importing the package from the root bundle (which esbuild
// flattens into a single file) does not trigger this IIFE.
if (require.main === module) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`run-reviews failed: ${message}`);
  });
}