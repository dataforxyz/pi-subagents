import assert from "node:assert/strict";
import test from "node:test";
import { backgroundForkDepthExceeded, currentBackgroundForkDepth, maxBackgroundForkDepth, subagentBackgroundEventId } from "../../src/runs/background/fork-handler.ts";

test("subagent background event ids are source namespaced", () => {
	assert.equal(subagentBackgroundEventId({ type: "async-complete", title: "done", content: "ok" }, "sbf_1"), "subagents:async-complete:sbf_1");
});

test("background fork depth helpers block nested subagent fork handlers by default", () => {
	assert.equal(currentBackgroundForkDepth({ PI_BACKGROUND_FORK_DEPTH: "2" }), 2);
	assert.equal(maxBackgroundForkDepth({ PI_BACKGROUND_MAX_FORK_DEPTH: "3" }), 3);
	assert.equal(backgroundForkDepthExceeded({ PI_BACKGROUND_FORK_DEPTH: "1", PI_BACKGROUND_MAX_FORK_DEPTH: "1" }), true);
	assert.equal(backgroundForkDepthExceeded({ PI_BACKGROUND_FORK_DEPTH: "0", PI_BACKGROUND_MAX_FORK_DEPTH: "1" }), false);
	assert.equal(backgroundForkDepthExceeded({}), false);
});
