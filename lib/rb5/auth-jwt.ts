import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ExtensionJwtUser = {
  uid: string;
  email: string;
  name: string;
  role: Role;
};

export type ExtensionPublicUser = {
  id: string;
  email: string;
  name: string;
  avatar: string;
  role: "admin" | "bidder";
  superAdmin: boolean;
  roleTags: string[];
  extensionEnabled: boolean;
};

function jwtSecret() {
  return (
    process.env.EXTENSION_JWT_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "dev-extension-secret"
  );
}

export function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
}): ExtensionPublicUser {
  const superAdmin = user.role === "ADMIN";
  const clientRole = user.role === "ADMIN" ? "admin" : "bidder";
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: "",
    role: clientRole,
    superAdmin,
    roleTags: clientRole === "admin" ? ["admin"] : ["bidder"],
    extensionEnabled: process.env.EXTENSION_ENABLED !== "false",
  };
}

export function signExtensionToken(user: ExtensionJwtUser) {
  return jwt.sign(
    {
      uid: user.uid,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    jwtSecret(),
    { expiresIn: "30d" },
  );
}

export function verifyExtensionToken(
  token: string,
): ExtensionJwtUser | null {
  try {
    const payload = jwt.verify(token, jwtSecret()) as {
      uid?: string;
      email?: string;
      name?: string;
      role?: Role;
    };
    if (!payload.uid || !payload.email || !payload.role) return null;
    return {
      uid: payload.uid,
      email: payload.email,
      name: payload.name || payload.email,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

export function bearerToken(req: Request) {
  // Prefer extension-specific header — Auth.js middleware can treat
  // Authorization: Bearer as its own session JWT and drop/break it.
  const custom = req.headers.get("x-bcd-token")?.trim();
  if (custom) return custom;

  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export async function requireExtensionUser(req: Request) {
  const token = bearerToken(req);
  if (!token) {
    const err = new Error("Unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  const payload = verifyExtensionToken(token);
  if (!payload) {
    const err = new Error("Unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  if (payload.role === "INTERVIEWER") {
    const err = new Error("Interviewers cannot use the extension API");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
  const user = await prisma.user.findUnique({ where: { id: payload.uid } });
  if (!user) {
    const err = new Error("Unauthorized");
    (err as Error & { status: number }).status = 401;
    throw err;
  }
  return {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  } satisfies ExtensionJwtUser;
}

export async function loginWithPassword(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) return null;
  if (user.role === "INTERVIEWER") return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  const jwtUser: ExtensionJwtUser = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  return {
    token: signExtensionToken(jwtUser),
    user: toPublicUser(user),
  };
}
