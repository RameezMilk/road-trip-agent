export class NotConfiguredError extends Error {
  constructor(feature: string, missing: string[]) {
    super(`${feature} is not configured (missing ${missing.join(", ")})`);
    this.name = "NotConfiguredError";
  }
}
