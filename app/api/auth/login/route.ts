import { handleAuth } from "@/lib/auth";

export function POST(request: Request): Promise<Response> {
  return handleAuth(request, "login");
}
