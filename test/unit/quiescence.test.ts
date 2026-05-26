import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getSubagentActivityGeneration, getSubagentParentActivityStatus, isSubagentParentQuiescent, markSubagentActivity, waitForSubagentParentQuiescence } from "../../src/extension/quiescence.ts";
import { deliverBackgroundForkEvent } from "../../src/runs/background/fork-handler.ts";
import { buildForkRunPaths, getForkHandlersFile } from "../../src/shared/fork-runtime.ts";
import type { SubagentState } from "../../src/shared/types.ts";

let originalHome: string | undefined;
let home: string;

function makeState(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-1",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeCtx(input: { idle?: boolean; pending?: boolean; sessionFile?: string | null } = {}) {
	return {
		isIdle: () => input.idle ?? true,
		hasPendingMessages: () => input.pending ?? false,
		sessionManager: {
			getSessionFile: () => input.sessionFile ?? null,
		},
	};
}

function writeHandlers(handlers: unknown[]): void {
	const file = getForkHandlersFile("subagents");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ version: 1, handlers }, null, 2)}\n`, "utf8");
}

function readHandlers(): Array<Record<string, unknown>> {
	const file = getForkHandlersFile("subagents");
	const raw = fs.readFileSync(file, "utf8");
	const parsed = JSON.parse(raw) as { handlers?: Array<Record<string, unknown>> };
	return parsed.handlers ?? [];
}

function writeHandlerScript(body = "sleep 0.2\n"): string {
	const script = path.join(home, `handler-${Math.random().toString(36).slice(2)}.sh`);
	fs.writeFileSync(script, `#!/bin/sh\n${body}`, "utf8");
	fs.chmodSync(script, 0o755);
	return script;
}

const fakePi = { sendMessage: () => {} };

function handler(id: string, parentSessionFile: string, status: "starting" | "running" | "complete" | "failed" = "running", pid = process.pid) {
	return {
		...buildForkRunPaths("subagents", id),
		type: "async-complete",
		title: `handler ${id}`,
		cwd: process.cwd(),
		status,
		startedAt: Date.now(),
		parentSessionFile,
		notify: "summary",
		triggerParentOnSummary: true,
		...(pid ? { pid } : {}),
	};
}

describe("subagent parent quiescence", () => {
	beforeEach(() => {
		originalHome = process.env.HOME;
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-quiescence-home-"));
		process.env.HOME = home;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("reports quiescent when the parent is idle and no subagent work is outstanding", async () => {
		const state = makeState();
		const ctx = makeCtx({ sessionFile: "/tmp/parent.jsonl" });

		const status = await getSubagentParentActivityStatus(ctx as never, state);

		assert.equal(status.quiescent, true);
		assert.equal(status.activityGeneration, 0);
		assert.equal(await isSubagentParentQuiescent(ctx as never, state), true);
		assert.deepEqual(status.activeSubagentRuns, []);
		assert.deepEqual(status.activeBackgroundForkHandlers, []);
	});

	it("blocks quiescence on the main parent agent and queued parent messages", async () => {
		const state = makeState();
		const active = await getSubagentParentActivityStatus(makeCtx({ idle: false }) as never, state);
		const pending = await getSubagentParentActivityStatus(makeCtx({ pending: true }) as never, state);

		assert.equal(active.quiescent, false);
		assert.equal(active.mainAgentActive, true);
		assert.equal(pending.quiescent, false);
		assert.equal(pending.pendingMessages, true);
	});

	it("blocks quiescence on foreground and async subagent runs owned by this parent", async () => {
		const state = makeState();
		state.foregroundControls.set("fg-1", {
			runId: "fg-1",
			mode: "single",
			startedAt: 100,
			updatedAt: 200,
			currentAgent: "reviewer",
		});
		state.asyncJobs.set("async-complete", {
			asyncId: "async-complete",
			asyncDir: "/tmp/async-complete",
			status: "complete",
		});
		state.asyncJobs.set("async-paused", {
			asyncId: "async-paused",
			asyncDir: "/tmp/async-paused",
			status: "paused",
			mode: "parallel",
			agents: ["reviewer"],
		});

		const status = await getSubagentParentActivityStatus(makeCtx() as never, state);

		assert.equal(status.quiescent, false);
		assert.deepEqual(status.activeSubagentRuns.map((run) => run.runId), ["fg-1", "async-paused"]);
	});

	it("blocks only on subagent fork handlers scoped to the current parent session", async () => {
		const parentSessionFile = path.join(home, "sessions", "parent.jsonl");
		const otherParentSessionFile = path.join(home, "sessions", "other.jsonl");
		writeHandlers([
			handler("sbf-matching", parentSessionFile),
			handler("sbf-other", otherParentSessionFile),
			handler("sbf-complete", parentSessionFile, "complete"),
		]);

		const status = await getSubagentParentActivityStatus(makeCtx({ sessionFile: parentSessionFile }) as never, makeState());
		const otherStatus = await getSubagentParentActivityStatus(makeCtx({ sessionFile: otherParentSessionFile }) as never, makeState());

		assert.equal(status.quiescent, false);
		assert.deepEqual(status.activeBackgroundForkHandlers.map((run) => run.id), ["sbf-matching"]);
		assert.equal(otherStatus.quiescent, false);
		assert.deepEqual(otherStatus.activeBackgroundForkHandlers.map((run) => run.id), ["sbf-other"]);
	});

	it("does not count unscoped persisted fork handlers when the parent session file is unavailable", async () => {
		writeHandlers([handler("sbf-unscoped", "")]);

		const status = await getSubagentParentActivityStatus(makeCtx({ sessionFile: null }) as never, makeState());

		assert.equal(status.quiescent, true);
		assert.deepEqual(status.activeBackgroundForkHandlers, []);
	});

	it("treats a newly starting scoped fork handler as outstanding even before its pid is persisted", async () => {
		const parentSessionFile = path.join(home, "sessions", "parent.jsonl");
		writeHandlers([handler("sbf-starting", parentSessionFile, "starting", 0)]);

		const status = await getSubagentParentActivityStatus(makeCtx({ sessionFile: parentSessionFile }) as never, makeState());

		assert.equal(status.quiescent, false);
		assert.deepEqual(status.activeBackgroundForkHandlers.map((run) => run.id), ["sbf-starting"]);
	});

	it("tracks activity generation and waits for a stable quiescent window", async () => {
		const state = makeState();
		const ctx = makeCtx({ sessionFile: "/tmp/parent.jsonl" });
		assert.equal(getSubagentActivityGeneration(state), 0);
		markSubagentActivity(state);
		assert.equal(getSubagentActivityGeneration(state), 1);

		let resolved = false;
		const wait = waitForSubagentParentQuiescence(ctx as never, state, { stableMs: 40, timeoutMs: 1_000, recheckMs: 20 })
			.then((status) => {
				resolved = true;
				return status;
			});
		setTimeout(() => markSubagentActivity(state), 20).unref?.();
		await new Promise((resolve) => setTimeout(resolve, 55));
		assert.equal(resolved, false, "activity during the stable window should reset the waiter");
		const status = await wait;
		assert.equal(status.quiescent, true);
		assert.equal(status.activityGeneration, 2);
	});

	it("waits for scoped background fork handlers to finish before reporting quiescence", async () => {
		const state = makeState();
		const parentSessionFile = path.join(home, "sessions", "parent.jsonl");
		writeHandlers([handler("sbf-running", parentSessionFile, "running", process.pid)]);
		const ctx = makeCtx({ sessionFile: parentSessionFile });

		let resolved = false;
		const wait = waitForSubagentParentQuiescence(ctx as never, state, { stableMs: 20, timeoutMs: 1_000, recheckMs: 20 })
			.then((status) => {
				resolved = true;
				return status;
			});
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(resolved, false, "running scoped fork handler should block waiter");

		writeHandlers([handler("sbf-running", parentSessionFile, "complete", process.pid)]);
		markSubagentActivity(state);
		const status = await wait;
		assert.equal(status.quiescent, true);
		assert.deepEqual(status.activeBackgroundForkHandlers, []);
	});

	it("sees a fork handler reservation synchronously before delivery persistence awaits complete", async () => {
		const state = makeState();
		const parentSessionFile = path.join(home, "sessions", "parent.jsonl");
		const script = writeHandlerScript("sleep 0.2\n");
		const delivery = deliverBackgroundForkEvent(
			fakePi as never,
			{ enabled: true, notify: "none", piCommand: script },
			{ type: "async-complete", title: "reserved handler", content: "done", parentSessionFile, cwd: process.cwd() },
			{ onActivity: () => markSubagentActivity(state) },
		);

		const status = await getSubagentParentActivityStatus(makeCtx({ sessionFile: parentSessionFile }) as never, state);
		assert.equal(status.quiescent, false);
		assert.deepEqual(status.activeBackgroundForkHandlers.map((run) => run.title), ["reserved handler"]);

		await delivery;
		await new Promise((resolve) => setTimeout(resolve, 250));
	});

	it("preserves concurrent fork handler deliveries in handlers.json", async () => {
		const parentSessionFile = path.join(home, "sessions", "parent.jsonl");
		const script = writeHandlerScript("sleep 0.3\n");
		const deliveries = Array.from({ length: 8 }, (_, index) => deliverBackgroundForkEvent(
			fakePi as never,
			{ enabled: true, notify: "none", piCommand: script },
			{ type: "async-complete", title: `concurrent handler ${index}`, content: "done", parentSessionFile, cwd: process.cwd() },
		));

		await Promise.all(deliveries);
		const titles = readHandlers().map((run) => run.title);
		for (let index = 0; index < deliveries.length; index += 1) {
			assert.ok(titles.includes(`concurrent handler ${index}`), `missing persisted handler ${index}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 350));
	});
});
