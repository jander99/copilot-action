/**
 * Public API surface of `validate-review`. The bundle exports
 * `validateReview` so the root action can drive validation without
 * going through `@actions/core` I/O. The new `claude` runtime is
 * exposed as `runClaudeValidator` for direct programmatic use and
 * as `ClaudeCodeValidatorRuntime` for tests / advanced callers.
 */

export { parseValidatorResponse, validateReview } from './main';
export type { ValidateReviewOptions, ValidateReviewResult, ValidatorTool } from './main';
export { runClaudeValidator, ClaudeCodeValidatorRuntime } from './claude-validate';
export type { ClaudeValidatorOptions, ClaudeValidatorResult } from './claude-validate';