// SPDX-License-Identifier: AGPL-3.0-only
export { loadEnv, envBool, envPort, EnvValidationError } from './env.js';
export { createLogger, REDACT_PATHS, type Logger } from './logger.js';
export { AppError, Errors, type ProblemDetails } from './errors.js';
export {
  generateGatewayKey,
  hashGatewayKey,
  keyPrefix,
  verifyKey,
  safeEqual,
  type GeneratedKey,
} from './gateway-key.js';
export {
  CHAT_NOTICE_DAYS,
  advanceRetention,
  changeRetention,
  deletionStartsAt,
  noticeEndsAt,
  noticeLate,
  retentionDay,
  retentionRowOf,
  retentionStateOf,
  type RetentionNotice,
  type RetentionRow,
  type RetentionState,
} from './chat-retention.js';
export {
  POLICY_CHANGED_CHANNEL,
  publishPolicyChanged,
  type PolicyPublisher,
} from './policy-events.js';

/** Who a service key's usage is recorded under. No such person exists, and it has no row. */
export const NO_PERSON = '00000000-0000-0000-0000-000000000000';
