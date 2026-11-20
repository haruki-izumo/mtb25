import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-8">
          <p className="text-sm font-medium text-blue-600">Interview Manager</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            Sign in
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Use your team email and password. Demo:{" "}
            <span className="font-medium text-slate-700">admin@example.com</span>{" "}
            / <span className="font-medium text-slate-700">password123</span>
          </p>
        </div>
        <Suspense fallback={<div className="h-40 animate-pulse rounded-lg bg-slate-100" />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
