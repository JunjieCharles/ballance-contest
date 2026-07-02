export class ServiceError extends Error {
  public constructor(public readonly code: string, message: string, public readonly statusCode: number, public readonly details?: unknown) { super(message); }
}
