import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isPublic = pathname.startsWith("/login");

  if (!isLoggedIn && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  if (isLoggedIn && pathname.startsWith("/login")) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const interviewerBlocked =
    pathname === "/projects" ||
    pathname.startsWith("/projects/") ||
    pathname === "/team" ||
    pathname.startsWith("/team/");

  if (
    isLoggedIn &&
    req.auth?.user?.role === "INTERVIEWER" &&
    interviewerBlocked
  ) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  // Exclude /api/* so Auth.js does not consume the extension's Bearer JWT
  // (Authorization header). Extension + NextAuth API routes handle their own auth.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
