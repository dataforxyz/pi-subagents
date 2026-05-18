#!/usr/bin/env node
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const userPiCommand = join(homedir(), ".local", "bin", "pi");
const piCommand = process.env.PI_LIVE_SMOKE_PI ?? (existsSync(userPiCommand) ? userPiCommand : "pi");
const model = process.env.PI_LIVE_SMOKE_MODEL ?? "openai-codex/gpt-5.5:minimal";
const keep = process.argv.includes("--keep");
const homeAgentDir = join(homedir(), ".pi", "agent");
let smokeEnv = {
	...process.env,
	PATH: (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => entry && !entry.endsWith("/node_modules/.bin"))
		.join(delimiter),
};

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		env: smokeEnv,
		maxBuffer: 10 * 1024 * 1024,
		...options,
	});
	return result;
}

function fail(message, details = {}) {
	console.error(`FAIL: ${message}`);
	for (const [key, value] of Object.entries(details)) {
		if (value === undefined || value === "") continue;
		console.error(`\n--- ${key} ---\n${value}`);
	}
	process.exit(1);
}

function readJsonl(filePath) {
	return readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				throw new Error(`${filePath}:${index + 1}: ${error.message}`);
			}
		});
}

function latestSessionFile(sessionDir) {
	const files = run("find", [sessionDir, "-maxdepth", "1", "-type", "f", "-name", "*.jsonl", "-printf", "%T@ %p\n"]);
	if (files.status !== 0) fail("could not list session files", { stderr: files.stderr });
	const sorted = files.stdout.trim().split("\n").filter(Boolean).sort((a, b) => Number(b.split(" ")[0]) - Number(a.split(" ")[0]));
	if (sorted.length === 0) fail("Pi did not create a session file", { sessionDir });
	return sorted[0].replace(/^\S+\s+/, "");
}

function subagentToolResults(entries) {
	return entries
		.map((entry) => entry?.message)
		.filter((message) => message?.role === "toolResult" && message.toolName === "subagent");
}

function firstExistingPath(paths) {
	return paths.find((candidate) => existsSync(candidate));
}

const tempRoot = mkdtempSync(join(tmpdir(), "pi-subagents-live-smoke-"));
const agentDir = join(tempRoot, "agent");
const sessionDir = join(tempRoot, "sessions");
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const intercomRoot = firstExistingPath([
	join(homedir(), "PrograminProjects", "pi-worktrees", "pi-intercom-live-context-demo"),
	join(homedir(), "src", "github.com", "dataforxyz", "pi-intercom"),
]);
const packages = [packageRoot, intercomRoot].filter(Boolean);
writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
	defaultProvider: "openai-codex",
	defaultModel: "gpt-5.5",
	defaultThinkingLevel: "minimal",
	packages,
}, null, 2)}\n`);

for (const file of ["auth.json", "models.json"]) {
	const source = join(homeAgentDir, file);
	if (existsSync(source)) copyFileSync(source, join(agentDir, file));
}

const subagentConfigDir = join(agentDir, "extensions", "subagent");
mkdirSync(subagentConfigDir, { recursive: true });
writeFileSync(join(subagentConfigDir, "config.json"), `${JSON.stringify({
	asyncByDefault: true,
	forceTopLevelAsync: true,
	backgroundForkHandlers: { enabled: true, notify: "summary", triggerParentOnSummary: false },
}, null, 2)}\n`);

smokeEnv = { ...smokeEnv, PI_CODING_AGENT_DIR: agentDir };

try {
	const list = run(piCommand, ["list"]);
	if (list.status !== 0) fail("pi list failed", { stdout: list.stdout, stderr: list.stderr });
	if (!list.stdout.includes(packageRoot)) {
		fail("isolated Pi settings do not appear to load this worktree package", {
			agentDir,
			packageRoot,
			"pi list": list.stdout,
		});
	}

	console.log(`Using isolated PI_CODING_AGENT_DIR=${agentDir}`);

	const doctorPrompt = "Use the subagent tool with action doctor. Then summarize the package root, package git line, asyncByDefault, forceTopLevelAsync, and background fork handler notify value.";
	const doctor = run(piCommand, [
		"-p",
		"--session-dir", sessionDir,
		"--model", model,
		"--no-builtin-tools",
		"--tools", "subagent",
		doctorPrompt,
	]);
	if (doctor.status !== 0) fail("doctor Pi run failed", { stdout: doctor.stdout, stderr: doctor.stderr });
	const doctorSession = latestSessionFile(sessionDir);
	const doctorResults = subagentToolResults(readJsonl(doctorSession));
	const doctorText = doctorResults.map((message) => message.content?.map((part) => part.text ?? "").join("\n") ?? "").join("\n---\n");
	for (const expected of [
		`- package root: ${packageRoot}`,
		"- asyncByDefault: true",
		"- forceTopLevelAsync: true",
		"notify=summary",
	]) {
		if (!doctorText.includes(expected)) fail(`doctor output missing ${expected}`, { doctorText, stdout: doctor.stdout, session: doctorSession });
	}

	const marker = "LIVE_SYNC_TEST_OK";
	const sync = run(piCommand, [
		"-p",
		"--session-dir", sessionDir,
		"--model", model,
		"--no-builtin-tools",
		"--tools", "subagent",
		`Use the subagent tool with agent delegate, context fresh, async false, and task: reply exactly ${marker} and use no tools. Then report whether the tool returned inline synchronously or returned an async run receipt.`,
	]);
	if (sync.status !== 0) fail("sync Pi run failed", { stdout: sync.stdout, stderr: sync.stderr });
	const syncSession = latestSessionFile(sessionDir);
	const syncResults = subagentToolResults(readJsonl(syncSession));
	const matching = syncResults.find((message) => message.details?.mode === "single" && message.details?.results?.some((result) => result.finalOutput === marker));
	if (!matching) {
		fail("did not find synchronous single subagent result with expected marker", {
			stdout: sync.stdout,
			stderr: sync.stderr,
			session: syncSession,
			toolResults: JSON.stringify(syncResults.map((message) => ({ text: message.content?.map((part) => part.text).join("\n"), details: message.details })), null, 2),
		});
	}
	if (matching.details?.asyncId) fail("explicit async:false returned an async run receipt", { details: JSON.stringify(matching.details, null, 2) });

	console.log("PASS pi-subagents live runtime smoke");
	console.log(`agentDir=${agentDir}`);
	console.log(`packageRoot=${packageRoot}`);
	console.log(`packages=${packages.join(",")}`);
	console.log(`sessionDir=${sessionDir}`);
	console.log(`doctorSession=${doctorSession}`);
	console.log(`syncSession=${syncSession}`);
	console.log(`syncStdout=${sync.stdout.trim()}`);
} finally {
	if (!keep) rmSync(tempRoot, { recursive: true, force: true });
}
