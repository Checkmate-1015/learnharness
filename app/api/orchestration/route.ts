import { changeOrchestration, OrchestrationInputError, readOrchestration } from "@/src/server";

/** LOCAL PATCH (folder-orchestrator). */
export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(readOrchestration());
}

export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => null);
		return Response.json(changeOrchestration(body));
	} catch (error) {
		const input = error instanceof OrchestrationInputError;
		if (!input) console.error("[orchestration] change failed:", error);
		return Response.json({ error: input ? error.message : "Could not save the folder settings." }, { status: input ? 400 : 500 });
	}
}
