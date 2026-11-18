import assert from "node:assert/strict";
import { it } from "node:test";
import { PluginFrontendManager } from "../components/plugin-manager.ts";
import type { PluginInfo } from "../src/core/plugins.ts";

const plugin = (id: string): PluginInfo => ({ id, origin: "community", enabled: true, status: "active", revision: "1", manifest: {
	apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", main: "main.js",
} });
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function manager(onlyPlugin?: () => string | undefined) {
	const activated: string[] = [];
	const created = new PluginFrontendManager({
		fetch: async () => new Response("{}"), pathname: () => "/", navigate() {},
		importModule: async url => ({ activate() { activated.push(/plugins\/([^/]+)\//.exec(url)![1]!); } }),
		...(onlyPlugin ? { onlyPlugin } : {}),
	});
	return { created, activated };
}

it("a plugin window activates only its own plugin's frontend", async t => {
	const f = manager(() => "motion");
	t.after(() => f.created.dispose());
	f.created.reconcile([plugin("motion"), plugin("ipad-scratchpad")]); await tick();
	assert.deepEqual(f.activated, ["motion"]);
});

it("the main window activates every enabled plugin", async t => {
	const all = manager(), unset = manager(() => undefined);
	t.after(() => { all.created.dispose(); unset.created.dispose(); });
	for (const f of [all, unset]) { f.created.reconcile([plugin("motion"), plugin("ipad-scratchpad")]); await tick(); }
	assert.deepEqual(all.activated.sort(), ["ipad-scratchpad", "motion"]);
	assert.deepEqual(unset.activated.sort(), ["ipad-scratchpad", "motion"]);
});
