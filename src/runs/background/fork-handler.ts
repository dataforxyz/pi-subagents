import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SUBAGENT_CHILD_ENV } from "../shared/pi-args.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import type { BackgroundForkHandlersConfig } from "../../shared/types.ts";

export type BackgroundForkHandlerNotify = "ack-and-summary" | "summary" | "none";

export interface ResolvedBackgroundForkHandlersConfig {
	enabled: boolean;
	notify: BackgroundForkHandlerNotify;
	triggerParentOnSummary: boolean;
	piCommand?: string;
}

export interface SubagentBackgroundForkEvent {
	type: "async-complete" | "async-step-complete" | "control-notice";
	title: string;
	content: string;
	cwd?: string;
	parentSessionFile?: string;
	parentIntercomTarget?: string;
	details?: unknown;
}

interface BackgroundForkRun {
	id: string;
	type: SubagentBackgroundForkEvent["type"];
	title: string;
	cwd: string;
	dir: string;
	eventPath: string;
	promptPath: string;
	stdoutPath: string;
	stderrPath: string;
	sessionDir: string;
	parentSessionFile?: string;
	parentIntercomTarget?: string;
	pid?: number;
}

const STATE_DIR = path.join(os.homedir(), ".local", "state", "pi-subagents");
const HANDLERS_DIR = path.join(STATE_DIR, "handlers");
const SUMMARY_LIMIT_BYTES = 16 * 1024;

function truncateText(text: string, limitBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= limitBytes) return text;
	const truncated = Buffer.from(text, "utf8").subarray(0, limitBytes).toString("utf8");
	return `${truncated}\n… truncated ${bytes - limitBytes} bytes`;
}

function fileSizeBytes(filePath: string): number | null {
	try {
		return fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function formatLogPath(label: "Output" | "Errors", filePath: string): string {
	const size = fileSizeBytes(filePath);
	if (size === null) return `${label}: unavailable (${filePath}, missing)`;
	if (label === "Errors" && size === 0) return `${label}: none (${filePath}, 0 B)`;
	return `${label}: ${filePath} (${size} B)`;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
}

function makeRunId(event: SubagentBackgroundForkEvent): string {
	return `sbf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${sanitizeSegment(event.type)}`;
}

function closeFdBestEffort(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Best effort cleanup; the child owns duplicated stdio fds after spawn succeeds.
	}
}

export function resolveBackgroundForkHandlersConfig(config?: BackgroundForkHandlersConfig): ResolvedBackgroundForkHandlersConfig {
	return {
		enabled: config?.enabled ?? true,
		notify: config?.notify ?? "ack-and-summary",
		triggerParentOnSummary: config?.triggerParentOnSummary ?? false,
		...(config?.piCommand ? { piCommand: config.piCommand } : {}),
	};
}

function buildSystemPrompt(run: BackgroundForkRun): string {
	return [
		"You are a background pi-subagents event handler in a sibling Pi process.",
		"Handle only the subagent event capsule in the latest user message.",
		"Do not continue unrelated parent work. Do not interrupt the parent unless a real decision or required parent action is needed.",
		"You may inspect referenced files, child session files, artifacts, and repo state to summarize or triage the event.",
		"Do the safe triage/checking in this fork. Do not send optional next steps, routine success, or no-action-needed updates back to the parent.",
		"If the event contains a concrete required parent action, blocker, or required parent follow-up, notify the parent through intercom instead of only writing a final summary.",
		"Use intercom({ action: \"send\", to: <parent>, message: ... }) for required actionable non-blocking parent notices; use intercom.ask only for true blocking decisions.",
		"Escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence.",
		...(run.parentIntercomTarget ? [`Parent intercom target: ${run.parentIntercomTarget}`] : []),
		`Handler id: ${run.id}`,
	].join("\n");
}

function buildPrompt(event: SubagentBackgroundForkEvent, run: BackgroundForkRun): string {
	return [
		"# pi-subagents background event",
		"",
		`Type: ${event.type}`,
		`Title: ${event.title}`,
		`Handler: ${run.id}`,
		"",
		"## Parent notification content",
		"",
		event.content,
		"",
		"## Event details",
		"",
		"```json",
		JSON.stringify(event.details ?? {}, null, 2),
		"```",
		"",
		"## Instructions",
		"",
		"Handle this background event without waking the parent feed for routine summaries. If the event includes a child session or artifact path, read it only when it helps triage accurately.",
		"Do safe checks in this fork. If your conclusion is routine success, optional follow-up, or no action needed, do not send an intercom message to the parent; just state that in your final summary.",
		...(run.parentIntercomTarget
			? [
				`Parent intercom target: ${run.parentIntercomTarget}`,
				`Only if the event content includes a concrete required parent action, blocker, or required parent follow-up, call intercom({ action: \"send\", to: ${JSON.stringify(run.parentIntercomTarget)}, message: \"...\" }) with a concise action request so the parent can start it. If delivery fails because the target is stale, missing, or ambiguous, call intercom({ action: \"list\" }) and retry with the full id of the non-fork parent session that matches this event's cwd/name, excluding sessions whose status contains \"fork-handler:\". Use intercom.ask only if you need a decision before you can proceed.`,
			]
			: ["No parent intercom target is available; include any required parent action in your final summary."]),
		"Final summary: state what you inspected, what you sent/escalated to the parent if anything, and whether further parent action is still needed.",
	].join("\n");
}

function formatAck(run: BackgroundForkRun): string {
	return [
		`Background subagent event forked: ${run.title}`,
		`Handler: ${run.id}${run.pid ? ` (pid ${run.pid})` : ""}`,
		`Handler dir: ${run.dir}`,
	].join("\n");
}

function formatSummary(run: BackgroundForkRun, status: "complete" | "failed", code: number | null, signal: NodeJS.Signals | null): string {
	const stdout = fs.existsSync(run.stdoutPath) ? fs.readFileSync(run.stdoutPath, "utf8") : "";
	const stderr = fs.existsSync(run.stderrPath) ? fs.readFileSync(run.stderrPath, "utf8") : "";
	const output = stdout.trim() || stderr.trim() || "(no handler output)";
	const exit = code !== null ? String(code) : signal ? `signal ${signal}` : "unknown";
	return [
		`Background subagent event handler ${status}: ${run.title}`,
		`Handler: ${run.id}`,
		`Exit: ${exit}`,
		formatLogPath("Output", run.stdoutPath),
		formatLogPath("Errors", run.stderrPath),
		"",
		truncateText(output, SUMMARY_LIMIT_BYTES),
	].join("\n");
}

function sendFallback(pi: Pick<ExtensionAPI, "sendMessage">, event: SubagentBackgroundForkEvent): void {
	pi.sendMessage(
		{
			customType: event.type === "control-notice" ? "subagent_control_notice" : "subagent-notify",
			content: event.content,
			display: true,
			details: event.details,
		},
		{ triggerTurn: false },
	);
}

export async function deliverBackgroundForkEvent(
	pi: Pick<ExtensionAPI, "sendMessage">,
	config: BackgroundForkHandlersConfig | undefined,
	event: SubagentBackgroundForkEvent,
): Promise<void> {
	const resolved = resolveBackgroundForkHandlersConfig(config);
	if (!resolved.enabled) {
		sendFallback(pi, event);
		return;
	}

	let stdoutFd: number | undefined;
	let stderrFd: number | undefined;
	try {
		const run: BackgroundForkRun = (() => {
			const id = makeRunId(event);
			const dir = path.join(HANDLERS_DIR, id);
			return {
				id,
				type: event.type,
				title: event.title,
				cwd: event.cwd ?? process.cwd(),
				dir,
				eventPath: path.join(dir, "event.json"),
				promptPath: path.join(dir, "prompt.md"),
				stdoutPath: path.join(dir, "stdout.log"),
				stderrPath: path.join(dir, "stderr.log"),
				sessionDir: path.join(dir, "sessions"),
				...(event.parentSessionFile ? { parentSessionFile: event.parentSessionFile } : {}),
				...(event.parentIntercomTarget ? { parentIntercomTarget: event.parentIntercomTarget } : {}),
			};
		})();

		await fs.promises.mkdir(run.sessionDir, { recursive: true });
		await fs.promises.writeFile(run.eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
		await fs.promises.writeFile(run.promptPath, buildPrompt(event, run), "utf8");

		const baseArgs = [
			"-p",
			"--session-dir",
			run.sessionDir,
			"--append-system-prompt",
			buildSystemPrompt(run),
			...(run.parentSessionFile ? ["--fork", run.parentSessionFile] : []),
			`@${run.promptPath}`,
		];
		const command = resolved.piCommand ? { command: resolved.piCommand, args: baseArgs } : getPiSpawnCommand(baseArgs);
		stdoutFd = fs.openSync(run.stdoutPath, "a");
		stderrFd = fs.openSync(run.stderrPath, "a");
		const child = spawn(command.command, command.args, {
			cwd: run.cwd,
			detached: true,
			env: {
				...process.env,
				[SUBAGENT_CHILD_ENV]: "1",
				PI_SUBAGENT_BACKGROUND_HANDLER: "1",
				PI_SUBAGENT_BACKGROUND_HANDLER_RUN_ID: run.id,
			},
			stdio: ["ignore", stdoutFd, stderrFd],
		});
		closeFdBestEffort(stdoutFd);
		closeFdBestEffort(stderrFd);
		stdoutFd = undefined;
		stderrFd = undefined;
		child.unref();

		let launchError: unknown;
		const spawned = await new Promise<boolean>((resolve) => {
			const onSpawn = () => {
				child.off("error", onError);
				resolve(true);
			};
			const onError = (error: Error) => {
				launchError = error;
				child.off("spawn", onSpawn);
				resolve(false);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		if (!spawned) {
			console.error("[pi-subagents] Failed to launch background fork handler:", launchError);
			sendFallback(pi, event);
			return;
		}
		run.pid = child.pid;
		if (resolved.notify === "ack-and-summary") {
			pi.sendMessage(
				{ customType: "subagent-fork-handler", content: formatAck(run), display: true, details: { id: run.id, type: run.type, status: "running", dir: run.dir, pid: run.pid } },
				{ triggerTurn: false },
			);
		}
		child.once("close", (code, signal) => {
			if (resolved.notify !== "summary" && resolved.notify !== "ack-and-summary") return;
			const status = code === 0 ? "complete" : "failed";
			pi.sendMessage(
				{ customType: "subagent-fork-handler", content: formatSummary(run, status, code, signal), display: true, details: { id: run.id, type: run.type, status, dir: run.dir, pid: run.pid, exitCode: code, signal } },
				{ triggerTurn: resolved.triggerParentOnSummary },
			);
		});
	} catch (error) {
		closeFdBestEffort(stdoutFd);
		closeFdBestEffort(stderrFd);
		console.error("[pi-subagents] Failed to start background fork handler:", error);
		sendFallback(pi, event);
	}
}
