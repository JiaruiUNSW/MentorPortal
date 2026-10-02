import { handleAuth } from "@/lib/auth";

export function GET(request: Request): Promise<Response> {
  return handleAuth(request, "ussoCallback");
}
