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

export const { handlers, auth, signIn, signOut } = NextAuth({
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
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        id: String(token.id ?? token.sub ?? ""),
        role: token.role as Role,
        avatarColor: String(token.avatarColor ?? "#2563eb"),
      };
      return session;
    },
  },
  trustHost: true,
});
