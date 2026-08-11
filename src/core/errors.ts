export type FailureKind = "STAGE" | "HARD" | "FATAL";

export class ForgeMindError extends Error {
  public constructor(
    message: string,
    public readonly kind: FailureKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class StageFailure extends ForgeMindError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "STAGE", options);
  }
}

export class HardFailure extends ForgeMindError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "HARD", options);
  }
}

export class FatalFailure extends ForgeMindError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "FATAL", options);
  }
}

export function classifyFailure(error: unknown): FailureKind {
  return error instanceof ForgeMindError ? error.kind : "FATAL";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
