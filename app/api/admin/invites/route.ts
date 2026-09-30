import { handleAuth } from "@/lib/auth";

export function GET(request: Request): Promise<Response> {
  return handleAuth(request, "invites");
}

export function POST(request: Request): Promise<Response> {
  return handleAuth(request, "createInvite");
}
