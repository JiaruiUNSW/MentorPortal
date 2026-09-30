export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
