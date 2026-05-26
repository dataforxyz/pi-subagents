import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildForkHandlerEnv, buildForkRunPaths, getForkHandlersFile, getForkStateDir, launchDetachedFork } from "../../shared/fork-runtime.ts";
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
	status?: "starting" | "running" | "complete" | "failed";
	startedAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	error?: string;
	finishSource?: "close" | "reconciled";
	notify: BackgroundForkHandlerNotify;
	triggerParentOnSummary: boolean;
	pid?: number;
}

interface BackgroundForkRunsState {
	version: 1;
	handlers: BackgroundForkRun[];
}

function stateDir(): string {
	return getForkStateDir("subagents");
}

function handlersFile(): string {
	return getForkHandlersFile("subagents");
}

const SUMMARY_LIMIT_BYTES = 16 * 1024;
const MAX_PERSISTED_HANDLERS = 200;
const STARTING_HANDLER_RECONCILE_GRACE_MS = 5_000;
const HANDLERS_LOCK_TIMEOUT_MS = 5_000;
const HANDLERS_LOCK_STALE_MS = 30_000;
const HANDLERS_LOCK_RETRY_MS = 25;

const activeBackgroundForkReservations = new Map<string, BackgroundForkRun>();
let persistedRunsQueue: Promise<void> = Promise.resolve();

export interface BackgroundForkRunSummary {
	id: string;
	type: SubagentBackgroundForkEvent["type"];
	title: string;
	cwd: string;
	dir: string;
	status?: BackgroundForkRun["status"];
	startedAt?: number;
	endedAt?: number;
	pid?: number;
	parentSessionFile?: string;
}

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

async function readPersistedRuns(): Promise<BackgroundForkRun[]> {
	try {
		const raw = await fs.promises.readFile(handlersFile(), "utf8");
		const parsed = JSON.parse(raw) as Partial<BackgroundForkRunsState>;
		return Array.isArray(parsed.handlers) ? parsed.handlers : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
}

async function writePersistedRuns(runs: BackgroundForkRun[]): Promise<void> {
	const filePath = handlersFile();
	await fs.promises.mkdir(stateDir(), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const state: BackgroundForkRunsState = { version: 1, handlers: runs.slice(-MAX_PERSISTED_HANDLERS) };
	await fs.promises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await fs.promises.rename(tmp, filePath);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePersistedRunsLock(): Promise<() => Promise<void>> {
	await fs.promises.mkdir(stateDir(), { recursive: true });
	const lockPath = `${handlersFile()}.lock`;
	const startedAt = Date.now();
	while (true) {
		try {
			const handle = await fs.promises.open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
			return async () => {
				await handle.close().catch(() => {});
				await fs.promises.unlink(lockPath).catch(() => {});
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const stat = await fs.promises.stat(lockPath);
				if (Date.now() - stat.mtimeMs > HANDLERS_LOCK_STALE_MS) {
					await fs.promises.unlink(lockPath).catch(() => {});
					continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				continue;
			}
			if (Date.now() - startedAt > HANDLERS_LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for subagent background fork handler state lock: ${lockPath}`);
			}
			await delay(HANDLERS_LOCK_RETRY_MS);
		}
	}
}

async function withPersistedRunsLock<T>(operation: () => Promise<T>): Promise<T> {
	const queued = persistedRunsQueue.catch(() => {}).then(async () => {
		const release = await acquirePersistedRunsLock();
		try {
			return await operation();
		} finally {
			await release();
		}
	});
	persistedRunsQueue = queued.then(() => {}, () => {});
	return queued;
}

async function persistRun(run: BackgroundForkRun): Promise<void> {
	await withPersistedRunsLock(async () => {
		const runs = await readPersistedRuns();
		const next = [...runs.filter((candidate) => candidate.id !== run.id), run];
		await writePersistedRuns(next);
	});
}

async function patchPersistedRun(id: string, patch: Partial<BackgroundForkRun>): Promise<void> {
	await withPersistedRunsLock(async () => {
		const runs = await readPersistedRuns();
		const index = runs.findIndex((candidate) => candidate.id === id);
		if (index === -1) return;
		runs[index] = { ...runs[index]!, ...patch };
		await writePersistedRuns(runs);
	});
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function normalizeSessionFile(file: string | null | undefined): string | undefined {
	if (!file || !file.trim()) return undefined;
	return path.resolve(file);
}

function isActiveForkRun(run: BackgroundForkRun): boolean {
	return run.status === "starting" || run.status === "running";
}

function reserveBackgroundForkRun(run: BackgroundForkRun): void {
	if (isActiveForkRun(run)) activeBackgroundForkReservations.set(run.id, run);
}

function releaseBackgroundForkRun(id: string): void {
	activeBackgroundForkReservations.delete(id);
}

function activeReservationsForParent(normalizedParentSessionFile: string): BackgroundForkRun[] {
	return Array.from(activeBackgroundForkReservations.values()).filter(
		(run) => isActiveForkRun(run) && normalizeSessionFile(run.parentSessionFile) === normalizedParentSessionFile,
	);
}

function summarizeForkRun(run: BackgroundForkRun): BackgroundForkRunSummary {
	return {
		id: run.id,
		type: run.type,
		title: run.title,
		cwd: run.cwd,
		dir: run.dir,
		status: run.status,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		pid: run.pid,
		parentSessionFile: run.parentSessionFile,
	};
}

export async function reconcileBackgroundForkRuns(): Promise<number> {
	return await withPersistedRunsLock(async () => {
		const runs = await readPersistedRuns();
		let changed = 0;
		const now = Date.now();
		const next = runs.map((run) => {
			if (run.status !== "starting" && run.status !== "running") return run;
			if (run.status === "running" && isProcessAlive(run.pid)) return run;
			if (run.status === "starting" && !run.pid && now - (run.startedAt ?? now) < STARTING_HANDLER_RECONCILE_GRACE_MS) return run;
			const stderr = fs.existsSync(run.stderrPath) ? fs.readFileSync(run.stderrPath, "utf8") : "";
			const status = run.status === "starting" || stderr.trim() ? "failed" : "complete";
			changed += 1;
			return {
				...run,
				status,
				endedAt: run.endedAt ?? now,
				exitCode: run.exitCode ?? null,
				signal: run.signal ?? null,
				finishSource: "reconciled" as const,
				...(status === "failed" ? { error: run.error || stderr.trim() || "handler was still starting when reconciliation found no live pid" } : {}),
			};
		});
		if (changed > 0) await writePersistedRuns(next);
		return changed;
	});
}

export async function listActiveBackgroundForkRunsForParent(parentSessionFile: string | null | undefined): Promise<BackgroundForkRunSummary[]> {
	const normalizedParentSessionFile = normalizeSessionFile(parentSessionFile);
	if (!normalizedParentSessionFile) return [];
	await reconcileBackgroundForkRuns();
	const runs = await readPersistedRuns();
	const activeById = new Map<string, BackgroundForkRun>();
	for (const run of runs) {
		if (isActiveForkRun(run) && normalizeSessionFile(run.parentSessionFile) === normalizedParentSessionFile) activeById.set(run.id, run);
	}
	for (const run of activeReservationsForParent(normalizedParentSessionFile)) activeById.set(run.id, run);
	return Array.from(activeById.values()).map(summarizeForkRun);
}

export async function hasActiveBackgroundForkRunsForParent(parentSessionFile: string | null | undefined): Promise<boolean> {
	return (await listActiveBackgroundForkRunsForParent(parentSessionFile)).length > 0;
}

export function resolveBackgroundForkHandlersConfig(config?: BackgroundForkHandlersConfig): ResolvedBackgroundForkHandlersConfig {
	return {
		enabled: config?.enabled ?? true,
		notify: config?.notify ?? "summary",
		triggerParentOnSummary: config?.triggerParentOnSummary ?? true,
		...(config?.piCommand ? { piCommand: config.piCommand } : {}),
	};
}

function parentNotificationModeLines(run: BackgroundForkRun): string[] {
	if (run.notify === "none") {
		return [
			"Parent notification mode: none",
			"Your final response is stored in handler logs only and will not be automatically posted to the parent transcript/context.",
		];
	}
	return [
		`Parent notification mode: ${run.notify}`,
		`Your final response WILL be copied into the parent transcript/context${run.triggerParentOnSummary ? " and will trigger a parent turn" : ""}.`,
		...(run.notify === "ack-and-summary" ? ["The parent already received a launch ack; do not repeat startup details unless relevant."] : []),
		"Keep the final response concise. If you already sent an intercom message to the parent, do not repeat its full content; just note that you escalated it.",
	];
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
		...parentNotificationModeLines(run),
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
		...parentNotificationModeLines(run),
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

function shouldWakeParentForFallback(event: SubagentBackgroundForkEvent): boolean {
	return event.type === "async-complete" || event.type === "control-notice";
}

function sendFallback(pi: Pick<ExtensionAPI, "sendMessage">, event: SubagentBackgroundForkEvent): void {
	pi.sendMessage(
		{
			customType: event.type === "control-notice" ? "subagent_control_notice" : "subagent-notify",
			content: event.content,
			display: true,
			details: event.details,
		},
		{ triggerTurn: shouldWakeParentForFallback(event) },
	);
}

export async function deliverBackgroundForkEvent(
	pi: Pick<ExtensionAPI, "sendMessage">,
	config: BackgroundForkHandlersConfig | undefined,
	event: SubagentBackgroundForkEvent,
	options: { onActivity?: () => void } = {},
): Promise<void> {
	const resolved = resolveBackgroundForkHandlersConfig(config);
	if (!resolved.enabled) {
		options.onActivity?.();
		sendFallback(pi, event);
		return;
	}

	const run: BackgroundForkRun = (() => {
		const id = makeRunId(event);
		return {
			...buildForkRunPaths("subagents", id),
			type: event.type,
			title: event.title,
			cwd: event.cwd ?? process.cwd(),
			status: "starting",
			startedAt: Date.now(),
			...(event.parentSessionFile ? { parentSessionFile: event.parentSessionFile } : {}),
			...(event.parentIntercomTarget ? { parentIntercomTarget: event.parentIntercomTarget } : {}),
			notify: resolved.notify,
			triggerParentOnSummary: resolved.triggerParentOnSummary,
		};
	})();
	reserveBackgroundForkRun(run);
	options.onActivity?.();
	void reconcileBackgroundForkRuns().catch((error) => {
		console.error("[pi-subagents] Failed to reconcile background fork handlers:", error);
	});

	try {
		await fs.promises.mkdir(run.sessionDir, { recursive: true });
		await fs.promises.writeFile(run.eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
		await fs.promises.writeFile(run.promptPath, buildPrompt(event, run), "utf8");
		await persistRun(run);
		options.onActivity?.();

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
		const launch = await launchDetachedFork({
			command: command.command,
			args: command.args,
			cwd: run.cwd,
			stdoutPath: run.stdoutPath,
			stderrPath: run.stderrPath,
			env: buildForkHandlerEnv("subagents", run.id, { ...process.env, [SUBAGENT_CHILD_ENV]: "1" }),
			onClose: (code, signal) => {
				options.onActivity?.();
				const status = code === 0 ? "complete" : "failed";
				run.status = status;
				run.endedAt = Date.now();
				run.exitCode = code;
				run.signal = signal;
				run.finishSource = "close";
				void patchPersistedRun(run.id, { status, endedAt: run.endedAt, exitCode: code, signal, finishSource: "close" })
					.catch((error) => {
						console.error("[pi-subagents] Failed to persist background fork handler completion:", error);
					})
					.finally(() => {
						releaseBackgroundForkRun(run.id);
						options.onActivity?.();
					});
				if (resolved.notify !== "summary" && resolved.notify !== "ack-and-summary") return;
				pi.sendMessage(
					{ customType: "subagent-fork-handler", content: formatSummary(run, status, code, signal), display: true, details: { id: run.id, type: run.type, status, dir: run.dir, pid: run.pid, exitCode: code, signal } },
					{ triggerTurn: resolved.triggerParentOnSummary },
				);
			},
		});
		if (!launch.ok) {
			const message = launch.error instanceof Error ? launch.error.message : String(launch.error);
			run.status = "failed";
			run.endedAt = Date.now();
			run.error = message;
			await patchPersistedRun(run.id, { status: "failed", endedAt: run.endedAt, error: message }).catch((error) => {
				console.error("[pi-subagents] Failed to persist background fork handler launch failure:", error);
			});
			releaseBackgroundForkRun(run.id);
			options.onActivity?.();
			console.error("[pi-subagents] Failed to launch background fork handler:", launch.error);
			sendFallback(pi, event);
			return;
		}
		run.pid = launch.pid;
		run.status = "running";
		await patchPersistedRun(run.id, { pid: launch.pid, status: "running" });
		options.onActivity?.();
		if (resolved.notify === "ack-and-summary") {
			pi.sendMessage(
				{ customType: "subagent-fork-handler", content: formatAck(run), display: true, details: { id: run.id, type: run.type, status: "running", dir: run.dir, pid: run.pid } },
				{ triggerTurn: false },
			);
		}
	} catch (error) {
		run.status = "failed";
		run.endedAt = Date.now();
		run.error = error instanceof Error ? error.message : String(error);
		await patchPersistedRun(run.id, { status: "failed", endedAt: run.endedAt, error: run.error }).catch((patchError) => {
			console.error("[pi-subagents] Failed to persist background fork handler startup failure:", patchError);
		});
		releaseBackgroundForkRun(run.id);
		options.onActivity?.();
		console.error("[pi-subagents] Failed to start background fork handler:", error);
		sendFallback(pi, event);
	}
}
