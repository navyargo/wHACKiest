import { dispatch } from "@/lib/server/http";
import { routes } from "@/lib/server/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (req: Request, { params }: Ctx) => dispatch(routes, req, (await params).path);
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
