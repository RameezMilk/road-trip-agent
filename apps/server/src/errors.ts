export class NotConfiguredError extends Error {
  constructor(feature: string, missing: string[]) {
    super(`${feature} is not configured (missing ${missing.join(", ")})`);
    this.name = "NotConfiguredError";
  }
}

/** Thrown by gated integrations that are scaffolded but intentionally not built yet. */
export class NotBuiltError extends Error {
  constructor(feature: string) {
    super(
      `${feature} is scaffolded but not built yet — it is gated on the Photon probe passing (docs/photon-probe.md).`,
    );
    this.name = "NotBuiltError";
  }
}
