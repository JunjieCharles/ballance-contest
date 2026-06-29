import { randomBytes } from "node:crypto";

export interface LocalSession {
  token: string;
  tabId: string;
  control: boolean;
  createdAt: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, LocalSession>();
  private controlTabId: string | undefined;

  public constructor(private readonly bootstrapToken: string) {}

  public exchange(providedToken: string, tabId: string): LocalSession {
    if (providedToken !== this.bootstrapToken) throw new Error("INVALID_BOOTSTRAP_TOKEN");
    const token = randomBytes(32).toString("base64url");
    const control = this.controlTabId === undefined;
    if (control) this.controlTabId = tabId;
    const session = { token, tabId, control, createdAt: new Date().toISOString() };
    this.sessions.set(token, session);
    return session;
  }

  public get(token: string | undefined): LocalSession | undefined { return token ? this.sessions.get(token) : undefined; }

  public acquire(token: string): LocalSession {
    const session = this.sessions.get(token);
    if (!session) throw new Error("UNAUTHORIZED");
    for (const [key, existing] of this.sessions) this.sessions.set(key, { ...existing, control: false });
    this.controlTabId = session.tabId;
    const controlled = { ...session, control: true };
    this.sessions.set(token, controlled);
    return controlled;
  }
}
