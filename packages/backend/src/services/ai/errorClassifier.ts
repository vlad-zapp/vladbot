import type { ClassifiedError } from "@vladbot/shared";

const CONTEXT_LIMIT_PATTERNS = [
  /context.*(length|limit|exceed)/i,
  /too many tokens/i,
  /maximum.*token/i,
  /max_tokens/i,
  /token limit/i,
  /input is too long/i,
  /prompt is too long/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /quota.*exceeded/i,
  /overloaded/i,
];

const AUTH_ERROR_PATTERNS = [
  /auth/i,
  /api.?key/i,
  /unauthorized/i,
  /forbidden/i,
  /401/,
  /403/,
  /invalid.*key/i,
];

export function classifyLLMError(err: Error): ClassifiedError {
  const msg = err.message;

  for (const pattern of CONTEXT_LIMIT_PATTERNS) {
    if (pattern.test(msg)) {
      return { message: msg, code: "CONTEXT_LIMIT", recoverable: true };
    }
  }

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(msg)) {
      return { message: msg, code: "RATE_LIMIT", recoverable: true };
    }
  }

  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return { message: msg, code: "AUTH_ERROR", recoverable: false };
    }
  }

  // Provider errors (network, 5xx, etc.)
  if (/5\d{2}|server error|network|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
    return { message: msg, code: "PROVIDER_ERROR", recoverable: true };
  }

  return { message: msg, code: "UNKNOWN", recoverable: false };
}
