import { z } from "zod";
import { FirstName } from "../schemas";
import type { NameDirectory } from "./port";

type Log = (event: string, data?: Record<string, unknown>) => void;

// GET /projects/{projectId}/users/ (Spectrum API, Basic projectId:projectSecret). Untrusted like any
// response: only the fields used here are read, and unknown fields are ignored.
const UsersResponse = z.object({
  data: z.object({
    users: z.array(
      z.object({
        firstName: z.string().nullable(),
        email: z.string().nullable(),
        phoneNumber: z.string(),
      }),
    ),
  }),
});

/** "+1 (919) 555-0001" and "19195550001" → "19195550001"; emails are compared case-insensitively. */
export function handleKey(handle: string): string {
  return handle.includes("@") ? handle.trim().toLowerCase() : handle.replace(/\D/g, "");
}

/** "ada lovelace" → "Ada"; null when it isn't a usable first name. */
export function cleanFirstName(raw: string | null): string | null {
  const first = raw?.trim().split(/\s+/)[0];
  if (!first || !/^\p{L}[\p{L}\p{M}'-]*$/u.test(first)) return null;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return FirstName.safeParse(name).success ? name : null;
}

/**
 * The names people were registered with in the Photon dashboard, so the agent doesn't have to ask.
 * One list call (all users) is cached; a handle that isn't in it triggers at most one refresh per
 * `refreshMs`, so someone added to the project mid-demo is picked up.
 */
export class PhotonUsers implements NameDirectory {
  private names = new Map<string, string>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly projectId: string,
    private readonly projectSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly log: Log = () => {},
    private readonly timeoutMs = 2500,
    private readonly refreshMs = 10_000,
  ) {}

  async firstName(handle: string): Promise<string | null> {
    const key = handleKey(handle);
    if (!this.names.has(key) && Date.now() - this.loadedAt > this.refreshMs) await this.load();
    return this.names.get(key) ?? null;
  }

  /** Loads (or reloads) the user list; concurrent callers share one request. Never throws. */
  load(): Promise<void> {
    this.loading ??= this.fetchUsers().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetchUsers(): Promise<void> {
    const started = Date.now();
    try {
      const auth = Buffer.from(`${this.projectId}:${this.projectSecret}`).toString("base64");
      const res = await this.fetchFn(`${this.baseUrl}/projects/${encodeURIComponent(this.projectId)}/users/`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = UsersResponse.parse(await res.json());
      const names = new Map<string, string>();
      let named = 0;
      for (const user of data.users) {
        const name = cleanFirstName(user.firstName);
        if (!name) continue;
        named++;
        names.set(handleKey(user.phoneNumber), name);
        if (user.email) names.set(handleKey(user.email), name);
      }
      this.names = names;
      this.loadedAt = Date.now();
      this.log("photon_users_loaded", { users: data.users.length, named, ms: Date.now() - started });
    } catch (error) {
      this.loadedAt = Date.now(); // don't hammer the API; the agent asks for names meanwhile
      this.log("photon_users_failed", { error: String(error) });
    }
  }
}
