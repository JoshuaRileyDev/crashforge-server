import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Request } from "express";

const COOKIE_NAME = "crashforge_dashboard_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

type SessionRecord = {
  expiresAt: number;
};

const sessions = new Map<string, SessionRecord>();

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, record] of sessions.entries()) {
    if (record.expiresAt <= now) sessions.delete(token);
  }
}

setInterval(cleanupExpiredSessions, 60_000).unref();

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join("="));
  }
  return out;
}

export function hashDashboardPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyDashboardPassword(password: string, hash: string | undefined): boolean {
  if (!hash) return false;
  const parts = hash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export function createDashboardSession(): string {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function revokeDashboardSession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(token);
}

export function getDashboardSessionTokenFromRequest(req: Request): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  return token?.trim() || undefined;
}

export function isDashboardSessionValid(token: string | undefined): boolean {
  if (!token) return false;
  const record = sessions.get(token);
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function buildDashboardSessionCookie(token: string, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
    SESSION_TTL_MS / 1000
  }${securePart}`;
}

export function buildDashboardSessionClearCookie(secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${securePart}`;
}
