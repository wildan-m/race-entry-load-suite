/** An error that maps directly to an HTTP response. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code Machine-readable error code returned to the client.
   * @param {Record<string, string>} [headers] Extra response headers.
   */
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

// gRPC status codes Firestore reports when it is overloaded or contended.
const RETRYABLE_GRPC = new Map([
  [4, 'deadline_exceeded'],
  [8, 'resource_exhausted'],
  [10, 'contention'],
  [14, 'unavailable'],
]);

/**
 * Turns a thrown error into the response a client should see.
 * Overload and contention become 503 with Retry-After, so a load test can count them apart from bugs.
 * @param {unknown} err
 * @returns {{status: number, body: {error: string}, headers: Record<string, string>, unexpected: boolean}}
 */
export function toResponse(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.code }, headers: err.headers, unexpected: false };
  }
  if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
    return { status: 400, body: { error: 'invalid_json' }, headers: {}, unexpected: false };
  }
  const grpcCode = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
  if (typeof grpcCode === 'number' && RETRYABLE_GRPC.has(grpcCode)) {
    return {
      status: 503,
      body: { error: RETRYABLE_GRPC.get(grpcCode) },
      headers: { 'Retry-After': '1' },
      unexpected: false,
    };
  }
  return { status: 500, body: { error: 'internal' }, headers: {}, unexpected: true };
}
