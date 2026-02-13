export {
  detectSensitiveText,
  redactSensitiveText,
  redactJsonValue,
  countSensitiveTextMatches,
  assertNoSensitiveText,
  SensitiveTextError,
  isSensitiveTextError,
  sensitiveTextErrorData
} from "../core/redaction.js";

export type {
  RedactionResult,
  SensitivePatternKind,
  SensitiveTextMatchSummary
} from "../core/redaction.js";
