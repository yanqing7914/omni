import type { SkillMarketErrorCode } from './types.js'

/** Default HTTP status for each public error code. */
const STATUS_BY_CODE: Record<SkillMarketErrorCode, number> = {
  INVALID_ID: 400,
  INVALID_BODY: 400,
  BODY_TOO_LARGE: 413,
  INVALID_MANIFEST: 502,
  MARKET_UNAVAILABLE: 502,
  SKILL_NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  ALREADY_INSTALLED: 200,
  CHECKSUM_MISMATCH: 502,
  DOWNLOAD_FAILED: 502,
  URL_NOT_ALLOWED: 400,
  UNSAFE_PATH: 400,
  INSTALL_TIMEOUT: 504,
  BUNDLED_NOT_REMOVABLE: 400,
  NOT_INSTALLED: 404,
  INTERNAL: 500,
}

/**
 * One typed failure that the HTTP layer can translate without guessing.
 *
 * `details` is intentionally not serialized: it carries request paths and
 * upstream URLs that must not be reflected to a browser caller.
 */
export class SkillMarketError extends Error {
  readonly code: SkillMarketErrorCode
  readonly status: number
  readonly cached?: boolean
  /**
   * True only for transport-level failures (connection refused, timeout, 5xx).
   * The mirror fallback retries those; a 404 is a definitive answer and must
   * not be retried against the other entry point of the same content.
   */
  readonly retryable?: boolean
  /** Upstream HTTP status when the failure came from a response. */
  readonly httpStatus?: number

  constructor(
    code: SkillMarketErrorCode,
    message: string,
    options: { status?: number; cached?: boolean; retryable?: boolean; httpStatus?: number } = {},
  ) {
    super(message)
    this.name = 'SkillMarketError'
    this.code = code
    this.status = options.status ?? STATUS_BY_CODE[code]
    if (options.cached !== undefined) this.cached = options.cached
    if (options.retryable !== undefined) this.retryable = options.retryable
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus
  }
}

/** Coerce anything thrown by the installer into a SkillMarketError. */
export function asSkillMarketError(error: unknown): SkillMarketError {
  if (error instanceof SkillMarketError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new SkillMarketError('INTERNAL', message)
}
