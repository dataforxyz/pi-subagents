import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildCompanionListLines,
	buildCompanionStartupMessage,
	collectCompanionStatuses,
	handleCompanionCommand,
	maybeSendCompanionStartupMessage,
} from "../../src/extension/companion-suggestions.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
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

function makeRuntime(options: { intercom?: boolean; promptTemplateModel?: boolean } = {}) {
	return {
		getAllTools: () => options.intercom ? [{ name: "intercom", sourceInfo: { path: "/tmp/pi-intercom/index.ts" } }] : [],
		getCommands: () => options.promptTemplateModel ? [{ name: "prompt-tool", sourceInfo: { path: "/tmp/pi-prompt-template-model/index.ts" } }] : [],
	};
}

describe("companion suggestions", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-suggestions-"));
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds grouped list recommendations when companions are inactive", () => {
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: {},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const lines = buildCompanionListLines(statuses).join("\n");

		assert.match(lines, /Recommended companions:/);
		assert.match(lines, /pi-intercom is not active/);
		assert.match(lines, /pi install npm:pi-intercom/);
		assert.match(lines, /pi-prompt-template-model is not active/);
		assert.match(lines, /pi install npm:pi-prompt-template-model/);
	});

	it("does not recommend pi-intercom from list when its bridge is explicitly off", () => {
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: { intercomBridge: { mode: "off" } },
			cwd: tempDir,
			workspaceKey: tempDir,
		});
		const lines = buildCompanionListLines(statuses).join("\n");

		assert.doesNotMatch(lines, /pi-intercom is not active/);
		assert.match(lines, /pi-prompt-template-model is not active/);
	});

	it("does not recommend installing pi-intercom from list when intercom config is disabled", () => {
		fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "intercom"), { recursive: true });
		fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "intercom", "config.json"), JSON.stringify({ enabled: false }), "utf-8");
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: {},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const lines = buildCompanionListLines(statuses).join("\n");

		assert.equal(statuses.find((status) => status.packageName === "pi-intercom")?.reason, "pi-intercom config is disabled");
		assert.doesNotMatch(lines, /pi-intercom is not active/);
		assert.match(lines, /pi-prompt-template-model is not active/);
	});

	it("does not treat similarly named source paths as active", () => {
		const statuses = collectCompanionStatuses({
			pi: {
				getAllTools: () => [{ name: "intercom", sourceInfo: { path: "/tmp/not-pi-intercom/index.ts" } }],
				getCommands: () => [{ name: "prompt-tool", sourceInfo: { path: "/tmp/not-pi-prompt-template-model/index.ts" } }],
			},
			config: {},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});

		assert.equal(statuses.find((status) => status.packageName === "pi-intercom")?.active, false);
		assert.equal(statuses.find((status) => status.packageName === "pi-prompt-template-model")?.active, false);
	});

	it("treats runtime package resources as active", () => {
		fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "pi-intercom"), { recursive: true });
		const statuses = collectCompanionStatuses({
			pi: makeRuntime({ intercom: true, promptTemplateModel: true }),
			config: {},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const lines = buildCompanionListLines(statuses).join("\n");

		assert.equal(statuses.find((status) => status.packageName === "pi-intercom")?.active, true);
		assert.equal(statuses.find((status) => status.packageName === "pi-prompt-template-model")?.active, true);
		assert.equal(lines, "");
	});

	it("honors package-specific dismissal", () => {
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: {
				companionSuggestions: {
					packages: {
						"pi-intercom": { dismissed: { user: true } },
					},
				},
			},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const lines = buildCompanionListLines(statuses).join("\n");

		assert.doesNotMatch(lines, /pi-intercom is not active/);
		assert.match(lines, /pi-prompt-template-model is not active/);
	});

	it("honors empty package-specific surfaces as no recommendation surfaces", () => {
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: {
				companionSuggestions: {
					packages: {
						"pi-intercom": { surfaces: [] },
						"pi-prompt-template-model": { enabled: false },
					},
				},
			},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});

		assert.equal(buildCompanionListLines(statuses).join("\n"), "");
		assert.equal(buildCompanionStartupMessage(statuses), null);
	});

	it("sends one LLM-visible startup message without triggering a turn", () => {
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: {},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const sent: unknown[] = [];
		const state = makeState(tempDir);
		const ctx = {
			cwd: tempDir,
			hasUI: true,
			ui: {},
			sessionManager: { getSessionId: () => "session", getSessionFile: () => null },
			modelRegistry: { getAvailable: () => [] },
		};

		maybeSendCompanionStartupMessage({
			pi: { sendMessage: (message: unknown, options?: unknown) => sent.push({ message, options }) },
			ctx: ctx as never,
			state,
			statuses,
		});
		maybeSendCompanionStartupMessage({
			pi: { sendMessage: (message: unknown, options?: unknown) => sent.push({ message, options }) },
			ctx: ctx as never,
			state,
			statuses,
		});

		assert.equal(sent.length, 1);
		assert.match(JSON.stringify(sent[0]), /pi install npm:pi-intercom/);
		assert.match(JSON.stringify(sent[0]), /pi install npm:pi-prompt-template-model/);
		assert.doesNotMatch(JSON.stringify(sent[0]), /triggerTurn/);
	});

	it("writes workspace dismissal through the companion command", () => {
		const ctx = { cwd: tempDir };
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: {},
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const result = handleCompanionCommand("hide pi-intercom workspace", ctx as never, statuses);
		const configPath = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "subagent", "config.json");
		const saved = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { companionSuggestions?: { packages?: Record<string, { dismissed?: { workspaces?: string[] } }> } };

		assert.equal(result.error, undefined);
		assert.match(result.text, /Hid pi-intercom recommendations for this workspace/);
		assert.deepEqual(saved.companionSuggestions?.packages?.["pi-intercom"]?.dismissed?.workspaces, [tempDir]);
	});

	it("preserves global companionSuggestions disablement when writing dismissal", () => {
		const ctx = { cwd: tempDir };
		const configPath = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "subagent", "config.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, `${JSON.stringify({ companionSuggestions: false }, null, "\t")}\n`, "utf-8");
		const statuses = collectCompanionStatuses({
			pi: makeRuntime(),
			config: { companionSuggestions: false },
			cwd: tempDir,
			orchestratorTarget: "subagent-chat-session",
			workspaceKey: tempDir,
		});
		const result = handleCompanionCommand("hide pi-intercom workspace", ctx as never, statuses);
		const saved = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { companionSuggestions?: { enabled?: boolean; packages?: Record<string, { dismissed?: { workspaces?: string[] } }> } };

		assert.equal(result.error, undefined);
		assert.equal(saved.companionSuggestions?.enabled, false);
		assert.deepEqual(saved.companionSuggestions?.packages?.["pi-intercom"]?.dismissed?.workspaces, [tempDir]);
	});
});
