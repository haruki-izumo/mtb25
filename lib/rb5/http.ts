import { NextResponse } from "next/server";

export function jsonOk(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: corsHeaders(),
  });
}

export function jsonError(err: unknown, fallbackStatus = 500) {
  const e = err as Error & { status?: number; code?: string };
  const status = e.status || fallbackStatus;
  return NextResponse.json(
    {
      message: e.message || "Server error",
      ...(e.code ? { code: e.code } : {}),
    },
    { status, headers: corsHeaders() },
  );
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-BCD-Client, X-BCD-Token",
  };
}

export function optionsOk() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
