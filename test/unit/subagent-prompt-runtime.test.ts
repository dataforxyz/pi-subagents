import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import registerSubagentPromptRuntime, {
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	compactRoutineHandlerReceiptMessages,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
};

const SKILLS_SECTION = "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-subagents</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-subagents/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
	"You are a subagent.",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
	"\nCurrent working directory: /repo",
].join("");

const PROMPT_WITH_EXPLICIT_SKILL = [
	"You are a subagent.\n\n<skill name=\"explicit\">\nKeep this section\n</skill>",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
].join("");

afterEach(() => {
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
});

describe("subagent prompt runtime", () => {
	it("strips only the project context block", () => {
		const rewritten = stripProjectContext(BASE_PROMPT);
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(rewritten.includes("The following skills provide specialized instructions for specific tasks."));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("strips only the inherited skills block", () => {
		const rewritten = stripInheritedSkills(BASE_PROMPT);
		assert.ok(rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("can strip both inherited sections together", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("injects a child-only boundary that forbids proposing or running subagents", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("If you need to edit files, call the actual edit/write tools."));
		assert.ok(rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("keeps explicitly injected skill content when inherited skills are stripped", () => {
		const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(rewritten.includes("<skill name=\"explicit\">"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(!rewritten.includes("# Project Context"));
	});

	it("strips the subagent orchestration skill even when inherited skills remain", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.includes("<name>safe-bash</name>"));
		assert.ok(!rewritten.includes("<name>pi-subagents</name>"));
		assert.ok(!rewritten.includes("delegate to subagents"));
	});

	it("strips explicit pi-subagents skill injection from child prompts", () => {
		const prompt = "Before\n\n<skill name=\"pi-subagents\">\nDo not keep this.\n</skill>\n\n<skill name=\"safe-bash\">\nKeep this.\n</skill>\nAfter";
		const rewritten = stripSubagentOrchestrationSkill(prompt);

		assert.ok(!rewritten.includes("Do not keep this"));
		assert.ok(rewritten.includes("<skill name=\"safe-bash\">"));
	});

	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, notify, control, otherCustom]), [user, otherCustom]);
	});

	it("compacts routine handler receipts for child context while preserving lookup pointers", () => {
		const handlerReceipt = {
			role: "custom",
			customType: "subagent-fork-handler",
			content: [
				"Background subagent event handler complete: delegate",
				"Handler: sbf_123",
				"Exit: 0",
				"Output: /tmp/pi-subagents/run/stdout.log (12000 B)",
				"Errors: none (/tmp/pi-subagents/run/stderr.log, 0 B)",
				"",
				"Routine success summary with useful marker DEMO_OK.",
				`NOISY LINE 1 ${"x".repeat(500)}`,
				`NOISY LINE 2 ${"x".repeat(500)}`,
				`NOISY LINE 3 ${"x".repeat(500)}`,
				`NOISY LINE 4 ${"x".repeat(500)}`,
			].join("\n"),
		};

		const result = stripParentOnlySubagentMessages([handlerReceipt]);
		assert.equal(result.length, 1);
		const compacted = result[0] as { content: string };
		assert.match(compacted.content, /compacted for child context/);
		assert.match(compacted.content, /Handler: sbf_123/);
		assert.match(compacted.content, /Output: \/tmp\/pi-subagents\/run\/stdout\.log \(12000 B\)/);
		assert.match(compacted.content, /Errors: none/);
		assert.match(compacted.content, /DEMO_OK/);
		assert.doesNotMatch(compacted.content, /NOISY LINE 4/);
		assert.ok(compacted.content.length < handlerReceipt.content.length);
	});

	it("does not compact handler receipts with non-empty stderr", () => {
		const receipt = {
			role: "custom",
			customType: "subagent-fork-handler",
			content: "Background subagent event handler complete: delegate\nHandler: sbf_123\nExit: 0\nOutput: /tmp/out.log (10 B)\nErrors: /tmp/err.log (42 B)\n\nWarning details should stay inline.",
		};

		assert.deepEqual(compactRoutineHandlerReceiptMessages([receipt]), [receipt]);
	});

	it("does not recompact already compacted handler receipts", () => {
		const compactedReceipt = {
			role: "custom",
			customType: "return-on-handler",
			content: "return_on handler receipt (compacted for model context; routine success).\nHandler: roh_123\nOutput: /tmp/out.log (10 B)",
		};

		assert.deepEqual(compactRoutineHandlerReceiptMessages([compactedReceipt]), [compactedReceipt]);
	});

	it("compacts routine handler receipts without stripping other parent messages", () => {
		const notify = { role: "custom", customType: "subagent-notify", content: "keep in parent context" };
		const handlerReceipt = {
			role: "custom",
			customType: "subagent-fork-handler",
			content: "Background subagent event handler complete: delegate\nHandler: sbf_123\nExit: 0\nOutput: /tmp/out.log (10 B)\nErrors: none (/tmp/err.log, 0 B)\n\nRoutine summary.",
		};

		const result = compactRoutineHandlerReceiptMessages([notify, handlerReceipt]);
		assert.equal(result[0], notify);
		assert.match((result[1] as { content: string }).content, /compacted for child context/);
		assert.match((result[1] as { content: string }).content, /Output: \/tmp\/out\.log/);
	});

	it("does not compact failed handler receipts", () => {
		const failedReceipt = {
			role: "custom",
			customType: "return-on-handler",
			content: "return_on handler failed: build\nHandler: roh_123\nExit: 1\nOutput: /tmp/out.log (10 B)\n\nFailure detail that should stay inline.",
		};

		assert.deepEqual(stripParentOnlySubagentMessages([failedReceipt]), [failedReceipt]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, subagentResult, readResult, mixedAssistant, pureSubagentCall]),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("sets the child intercom session name from env during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; setSessionName(name: string): void });

		await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });

		assert.equal(sessionName, "subagent-worker-78f659a3");
	});

	it("rewrites the final child-visible prompt through before_agent_start", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		assert.ok(beforeAgentStart, "expected before_agent_start handler");
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }), undefined);
	});
});
