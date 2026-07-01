import assert from "node:assert/strict";
import test from "node:test";
import { buildForkRunPaths, getForkStateDir, getForkStateRoot } from "../../src/shared/fork-runtime.ts";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("fork state defaults to home-local source directory", () => {
	withEnv({ PI_BACKGROUND_STATE_DIR: undefined, PI_FORKS_STATE_ROOT: undefined, PI_SUBAGENTS_STATE_DIR: undefined }, () => {
		assert.equal(getForkStateRoot("/tmp/home"), "/tmp/home/.local/state");
		assert.equal(getForkStateDir("subagents", "/tmp/home"), "/tmp/home/.local/state/pi-subagents");
	});
});

test("fork state honors shared background root", () => {
	withEnv({ PI_BACKGROUND_STATE_DIR: "~/background", PI_FORKS_STATE_ROOT: undefined, PI_SUBAGENTS_STATE_DIR: undefined }, () => {
		assert.equal(getForkStateRoot("/tmp/home"), "/tmp/home/background");
		assert.equal(getForkStateDir("subagents", "/tmp/home"), "/tmp/home/background/pi-subagents");
		assert.equal(buildForkRunPaths("subagents", "sbf_test", "/tmp/home").dir, "/tmp/home/background/pi-subagents/handlers/sbf_test");
	});
});

test("source-specific subagent state dir overrides shared root", () => {
	withEnv({ PI_BACKGROUND_STATE_DIR: "/tmp/background", PI_SUBAGENTS_STATE_DIR: "~/subagent-state" }, () => {
		assert.equal(getForkStateDir("subagents", "/tmp/home"), "/tmp/home/subagent-state");
	});
});
