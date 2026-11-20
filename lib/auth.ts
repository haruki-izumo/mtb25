import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: Role;
  avatarColor: string;
};

declare module "next-auth" {
  interface User {
    role: Role;
    avatarColor: string;
  }

  interface Session {
    user: SessionUser;
  }
}

const authSecret =
  process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: authSecret,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
        });
        if (!user) return null;

        const valid = await bcrypt.compare(
          parsed.data.password,
          user.passwordHash,
        );
        if (!valid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatarColor: user.avatarColor,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
        token.role = user.role;
        token.avatarColor = user.avatarColor;
        return token;
      }

      // Re-resolve from DB so reseeds / id changes don't leave a stale JWT
      // that breaks FKs (e.g. InterviewProcess.ownerMemberId).
      const tokenId = typeof token.id === "string" ? token.id : undefined;
      const tokenEmail =
        typeof token.email === "string" ? token.email.toLowerCase() : undefined;

      const dbUser = tokenId
        ? await prisma.user.findUnique({ where: { id: tokenId } })
        : null;
      const resolved =
        dbUser ??
        (tokenEmail
          ? await prisma.user.findUnique({ where: { email: tokenEmail } })
          : null);

      if (!resolved) {
        return { ...token, id: undefined, error: "UserNotFound" };
      }

      token.id = resolved.id;
      token.role = resolved.role;
      token.avatarColor = resolved.avatarColor;
      token.name = resolved.name;
      token.email = resolved.email;
      delete token.error;
      return token;
    },
    async session({ session, token }) {
      if (token.error === "UserNotFound" || !token.id) {
        // Downstream requireSession redirects when id is missing
        session.user = {
          ...session.user,
          id: "",
          role: "MEMBER",
          avatarColor: "#2563eb",
        };
        return session;
      }
      session.user = {
        ...session.user,
        id: String(token.id),
        name: typeof token.name === "string" ? token.name : session.user.name,
        email:
          typeof token.email === "string" ? token.email : session.user.email,
        role: token.role as Role,
        avatarColor: String(token.avatarColor ?? "#2563eb"),
      };
      return session;
    },
  },
  trustHost: true,
});
