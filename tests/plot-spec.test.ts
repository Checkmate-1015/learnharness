/** Local patch (visual-plots): the ```plot fence spec compiler. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileExpr, compilePlot, defaultParams, parsePlotSpec } from "../components/plot-spec.ts";

describe("plot expressions", () => {
	it("handles precedence, unary minus, implicit products and constants", () => {
		assert.equal(compileExpr("-x^2")({ x: 3 }), -9);
		assert.equal(compileExpr("2x + 3(x+1)")({ x: 1 }), 8);
		assert.equal(compileExpr("3x^2+2x*y+y^2")({ x: 1, y: 2 }), 11);
		assert.ok(Math.abs(compileExpr("2pi")({}) - 2 * Math.PI) < 1e-12);
		assert.equal(compileExpr("xy")({ x: 2, y: 5 }), 10);
		assert.equal(compileExpr("atan2(1, 1)*4")({}), Math.PI);
		assert.equal(compileExpr("2^3^2")({}), 512);
	});
	it("rejects code", () => {
		assert.throws(() => compileExpr("alert(1)")({}));
		assert.throws(() => compileExpr("x; process.exit()"));
		assert.throws(() => compileExpr("foo")({}));
	});
});

describe("plot compile", () => {
	it("compiles a 2D SVD picture with params", () => {
		const spec = parsePlotSpec(JSON.stringify({
			params: { a: { min: 0, max: 3, value: 2 } },
			items: [
				{ kind: "curve", x: "cos(t)", y: "sin(t)", label: "unit circle" },
				{ kind: "curve", x: "a*cos(t)", y: "sin(t)" },
				{ kind: "vector", to: ["a", 0], label: "σ₁u₁" },
				{ kind: "levels", f: "x^2 + 4y^2", levels: [1, 4] },
			],
		}));
		const out = compilePlot(spec, defaultParams(spec));
		assert.equal(out.threeD, false);
		assert.equal(out.data.length, 4); // 2 curves + 2 level traces
		const ellipse = out.data[1] as { x: number[] };
		assert.ok(Math.abs(ellipse.x[0]! - 2) < 1e-9);
		const ann = (out.layout.annotations as { x: number }[]);
		assert.equal(ann[0]!.x, 2);
	});
	it("goes 3D for surfaces and parametric surfaces", () => {
		const spec = parsePlotSpec(JSON.stringify({ items: [
			{ kind: "surface", z: "x^2 - y^2" },
			{ kind: "surface", x: "cos(u)sin(v)", y: "sin(u)sin(v)", z: "cos(v)" },
			{ kind: "curve", x: "t", y: "0", z: "t^2", t: [-2, 2] },
			{ kind: "vector", to: [1, 0, 1] },
		] }));
		const out = compilePlot(spec, {});
		assert.equal(out.threeD, true);
		assert.ok("scene" in out.layout);
		assert.equal(out.data.filter((d) => d.type === "surface").length, 2);
	});
	it("passes raw plotly through and reports bad specs", () => {
		assert.equal(compilePlot(parsePlotSpec('{"data":[{"type":"scatter","x":[1],"y":[2]}]}'), {}).data.length, 1);
		assert.throws(() => parsePlotSpec("{}"));
		assert.throws(() => compilePlot(parsePlotSpec('{"items":[{"kind":"nope"}]}'), {}));
	});
});
