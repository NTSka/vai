export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function unauthorized(message = "Authentication required"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, "forbidden", message);
}
