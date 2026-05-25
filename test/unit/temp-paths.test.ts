import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ARTIFACTS_DIR,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveTempRootBase,
	resolveTempScopeId,
} from "../../src/shared/types.ts";

describe("resolveTempScopeId", () => {
	it("prefers uid when available", () => {
		const scope = resolveTempScopeId({
			getuid: () => 501,
			env: { USER: "alice" },
			userInfo: () => ({ username: "alice" }),
		});
		assert.equal(scope, "uid-501");
	});

	it("falls back to environment usernames when uid is unavailable", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: { USERNAME: "Alice Example" },
			userInfo: () => ({ username: "ignored" }),
		});
		assert.equal(scope, "user-Alice-Example");
	});

	it("falls back to os.userInfo when environment is missing", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => ({ username: "svc_account" }),
		});
		assert.equal(scope, "user-svc_account");
	});

	it("falls back to home path when os.userInfo throws", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => {
				throw new Error("uv_os_get_passwd returned ENOENT");
			},
			homedir: () => "/home/12345/app user",
		});
		assert.equal(scope, "home-home-12345-app-user");
	});
});

describe("resolveTempRootBase", () => {
	it("prefers explicit PI_SUBAGENTS_TMPDIR over TMPDIR", () => {
		assert.equal(
			resolveTempRootBase({ env: { PI_SUBAGENTS_TMPDIR: "./subagents-tmp", TMPDIR: "/tmp/ignored" } }),
			path.resolve("./subagents-tmp"),
		);
	});

	it("uses TMPDIR when no subagents-specific temp root is configured", () => {
		assert.equal(
			resolveTempRootBase({ env: { TMPDIR: "/var/tmp/custom" } }),
			path.resolve("/var/tmp/custom"),
		);
	});

	it("falls back to the home tmp directory before os tmp", () => {
		assert.equal(
			resolveTempRootBase({ env: { HOME: "/home/alice" }, homedir: () => "/home/ignored", tmpdir: () => "/tmp" }),
			path.join("/home/alice", "tmp"),
		);
		assert.equal(
			resolveTempRootBase({ env: {}, homedir: () => "/Users/bob", tmpdir: () => "/tmp" }),
			path.join("/Users/bob", "tmp"),
		);
	});

	it("uses os tmp only when no home directory can be resolved", () => {
		assert.equal(
			resolveTempRootBase({ env: {}, homedir: () => "", tmpdir: () => "/tmp" }),
			"/tmp",
		);
	});

	it("uses os tmp when home lookup throws", () => {
		assert.equal(
			resolveTempRootBase({ env: {}, homedir: () => { throw new Error("no home"); }, tmpdir: () => "/tmp" }),
			"/tmp",
		);
	});
});

describe("shared temp paths", () => {
	it("anchors shared temp directories under one scoped root", () => {
		assert.equal(path.dirname(RESULTS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(ASYNC_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(CHAIN_RUNS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(TEMP_ARTIFACTS_DIR), TEMP_ROOT_DIR);
		assert.match(path.basename(TEMP_ROOT_DIR), /^pi-subagents-/);
		assert.equal(path.basename(RESULTS_DIR), "async-subagent-results");
		assert.equal(path.basename(ASYNC_DIR), "async-subagent-runs");
		assert.equal(path.basename(CHAIN_RUNS_DIR), "chain-runs");
		assert.equal(path.basename(TEMP_ARTIFACTS_DIR), "artifacts");
	});

	it("writes async config files under the same scoped temp root", () => {
		assert.equal(path.dirname(getAsyncConfigPath("abc123")), TEMP_ROOT_DIR);
		assert.equal(path.basename(getAsyncConfigPath("abc123")), "async-cfg-abc123.json");
	});
});
