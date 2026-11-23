import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emptyOrchestration, parseOrchestration, type OrchestrationState } from "../core/orchestration.ts";
import { emit } from "../core/events.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** LOCAL PATCH (folder-orchestrator): data/orchestration.json. A corrupt
 * file refuses writes (never silently resets the learner's folder setup). */
export const ORCHESTRATION_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "orchestration.json");

export const orchestrationStore = {
	read(): OrchestrationState {
		let raw: string;
		try { raw = fs.readFileSync(ORCHESTRATION_FILE, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyOrchestration();
			throw error;
		}
		return parseOrchestration(JSON.parse(raw));
	},
	write(state: OrchestrationState): void {
		const valid = parseOrchestration(state);
		fs.mkdirSync(path.dirname(ORCHESTRATION_FILE), { recursive: true });
		writeFileAtomicSync(ORCHESTRATION_FILE, JSON.stringify(valid, null, "\t") + "\n");
		emit("sources-changed", {});
	},
};
