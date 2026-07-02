import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildForkHandlerEnv, buildForkRunPaths, getForkHandlersFile, getForkStateDir, launchDetachedFork } from "../../shared/fork-runtime.ts";
import { SUBAGENT_CHILD_ENV } from "../shared/pi-args.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import type { BackgroundForkHandlersConfig } from "../../shared/types.ts";

export type BackgroundForkHandlerNotify = "ack-and-summary" | "summary" | "none";

export function currentBackgroundForkDepth(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.PI_BACKGROUND_FORK_DEPTH ?? "0");
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function maxBackgroundForkDepth(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.PI_BACKGROUND_MAX_FORK_DEPTH ?? "1");
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

export function backgroundForkDepthExceeded(env: NodeJS.ProcessEnv = process.env): boolean {
	return currentBackgroundForkDepth(env) >= maxBackgroundForkDepth(env);
}

export interface ResolvedBackgroundForkHandlersConfig {
	enabled: boolean;
	mode: "auto" | "always";
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
let backgroundQueueDrainActive = false;
let backgroundQueueDrainPending = false;

type BackgroundRouterDecision = "fork" | "wake_main" | "display" | "queue";
type BackgroundEventsModule = {
	BackgroundEventsStore: new (...args: never[]) => {
		routeEvent: (envelope: Record<string, unknown>, options?: Record<string, unknown>) => { disposition: string; handlerId?: string; queueId?: string };
		runReconcilerPass: (options: Record<string, unknown>) => { leaseAcquired: boolean; launchBundles?: Array<{ handlerId: string; source: string; events: Array<{ payloadPath: string }> }> };
		markHandlerRunning: (handlerId: string, input?: Record<string, unknown>) => void;
		failHandlerLaunch: (handlerId: string, options?: Record<string, unknown>) => unknown;
		completeHandler: (handlerId: string, input?: Record<string, unknown>) => string | undefined;
		chargeAutoForkForLineage?: (input: Record<string, unknown>) => { allowed: boolean; reason?: string };
		upsertLineageBudget: (input: Record<string, unknown>) => void;
		canAutoFork: (input: { forkDepth?: number; maxForkDepth?: number; lineageId?: string; forkable?: boolean }) => { allowed: boolean; reason?: string };
		chargeLineageFollowup: (input: { lineageId: string; forkable?: boolean; now?: number }) => { allowed: boolean; reason?: string };
		close: () => void;
	};
	runOptionalRouterDecision?: (input: {
		config?: Record<string, unknown>;
		fallback: BackgroundRouterDecision;
		railsAllowed?: BackgroundRouterDecision[];
		ambiguous?: boolean;
		decide?: (input: { fallback: BackgroundRouterDecision; railsAllowed?: BackgroundRouterDecision[] }) => unknown;
	}) => Promise<{ decision: BackgroundRouterDecision; reason: string }>;
	namespacedEventId: (source: "subagents", durableId: string) => string;
};
const DEFAULT_BACKGROUND_EVENTS_MODULE = "pi-forks/background-events";
let backgroundEventsImport: Promise<BackgroundEventsModule | undefined> | undefined;
let backgroundEventsImportSpecifier: string | undefined;

function installedPiForksBackgroundEventsModule(): string | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
		? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
		: path.join(os.homedir(), ".pi", "agent");
	const filePath = path.join(agentDir, "git", "github.com", "dataforxyz", "pi-forks", "src", "background-events.ts");
	return fs.existsSync(filePath) ? pathToFileURL(filePath).href : undefined;
}

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

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function subagentParentNamespace(event: SubagentBackgroundForkEvent): string {
	return event.parentSessionFile ?? event.parentIntercomTarget ?? `subagents:${shortHash(stableJson({ cwd: event.cwd ?? process.cwd(), title: event.title }))}`;
}

export function subagentBackgroundEventId(event: SubagentBackgroundForkEvent, runId: string): string {
	return `subagents:${event.type}:${runId}`;
}

function subagentWorkIdentity(event: SubagentBackgroundForkEvent): string {
	const details = objectValue(event.details);
	const nestedEvent = objectValue(details?.event);
	const candidates = [
		stringValue(details?.runId),
		stringValue(nestedEvent?.runId),
		stringValue(details?.sessionValue),
		stringValue(details?.childIntercomTarget),
		stringValue(nestedEvent?.agent),
	].filter(Boolean);
	return candidates.length > 0 ? candidates.join(":") : shortHash(stableJson({ type: event.type, title: event.title, content: event.content, details: event.details }));
}

function subagentWorkKey(event: SubagentBackgroundForkEvent): string {
	return `subagents:${subagentParentNamespace(event)}:${event.type}:${subagentWorkIdentity(event)}`;
}

async function loadBackgroundEventsModule(): Promise<BackgroundEventsModule | undefined> {
	const specifier = process.env.PI_BACKGROUND_EVENTS_MODULE?.trim() || DEFAULT_BACKGROUND_EVENTS_MODULE;
	const fallbacks = [specifier, installedPiForksBackgroundEventsModule()].filter(Boolean) as string[];
	const cacheKey = fallbacks.join("\n");
	if (!backgroundEventsImport || backgroundEventsImportSpecifier !== cacheKey) {
		backgroundEventsImportSpecifier = cacheKey;
		backgroundEventsImport = (async () => {
			for (const candidate of fallbacks) {
				try {
					return await import(candidate) as BackgroundEventsModule;
				} catch {}
			}
			return undefined;
		})();
	}
	return backgroundEventsImport;
}

async function fileSnapshot(filePath: string): Promise<{ sha256: string; bytes: number }> {
	const data = await fs.promises.readFile(filePath);
	return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

async function routeSubagentBackgroundEvent(event: SubagentBackgroundForkEvent, run: BackgroundForkRun): Promise<{ disposition: string; handlerId?: string; queueId?: string } | undefined> {
	const module = await loadBackgroundEventsModule();
	if (!module) return undefined;
	const snapshot = await fileSnapshot(run.eventPath);
	const parentNamespace = subagentParentNamespace(event);
	const workKey = subagentWorkKey(event);
	const store = new module.BackgroundEventsStore();
	try {
		return store.routeEvent({
			version: 1,
			source: "subagents",
			eventId: module.namespacedEventId("subagents", subagentBackgroundEventId(event, run.id)),
			workKey,
			parentNamespace,
			parent: {
				sessionId: parentNamespace,
				...(event.parentSessionFile ? { sessionFile: event.parentSessionFile } : {}),
				...(event.parentIntercomTarget ? { intercomTarget: event.parentIntercomTarget } : {}),
				cwd: run.cwd,
			},
			createdAt: run.startedAt ?? Date.now(),
			priority: event.type === "control-notice" ? "high" : "normal",
			payloadPath: run.eventPath,
			payloadSha256: snapshot.sha256,
			payloadBytes: snapshot.bytes,
			needsDecision: event.type === "control-notice",
			eventType: event.type,
			origin: {
				forkDepth: currentBackgroundForkDepth(),
				handlerId: process.env.PI_BACKGROUND_HANDLER_ID,
				rootEventId: process.env.PI_BACKGROUND_EVENT_ID,
				rootWorkKey: process.env.PI_BACKGROUND_WORK_KEY,
				lineageId: process.env.PI_BACKGROUND_LINEAGE_ID,
			},
		}, { handlerId: run.id });
	} finally {
		store.close();
	}
}

async function markBackgroundHandlerRunning(run: BackgroundForkRun): Promise<void> {
	const module = await loadBackgroundEventsModule();
	if (!module) return;
	const store = new module.BackgroundEventsStore();
	try {
		store.markHandlerRunning(run.id, { pid: run.pid, supervisorPid: process.pid, processGroupId: run.pid });
	} finally {
		store.close();
	}
}

async function failBackgroundHandlerLaunch(handlerId: string, error: unknown): Promise<void> {
	const module = await loadBackgroundEventsModule();
	if (!module) return;
	const store = new module.BackgroundEventsStore();
	try {
		store.failHandlerLaunch(handlerId, { error: error instanceof Error ? error.message : String(error), requeue: true });
	} finally {
		store.close();
	}
}

async function completeBackgroundHandler(run: BackgroundForkRun): Promise<void> {
	const module = await loadBackgroundEventsModule();
	if (!module) return;
	const store = new module.BackgroundEventsStore();
	try {
		store.completeHandler(run.id, { status: run.status === "complete" ? "complete" : "failed", summaryPath: run.stdoutPath });
	} finally {
		store.close();
	}
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

function retainedPersistedRuns(runs: BackgroundForkRun[]): BackgroundForkRun[] {
	const active = runs.filter((run) => run.status === "starting" || run.status === "running");
	const activeIds = new Set(active.map((run) => run.id));
	const terminal = runs.filter((run) => !activeIds.has(run.id)).slice(-MAX_PERSISTED_HANDLERS);
	return [...terminal, ...active];
}

async function writePersistedRuns(runs: BackgroundForkRun[]): Promise<void> {
	const filePath = handlersFile();
	await fs.promises.mkdir(stateDir(), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const state: BackgroundForkRunsState = { version: 1, handlers: retainedPersistedRuns(runs) };
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
		mode: config?.mode ?? "auto",
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

function isSubagentBackgroundForkEvent(value: unknown): value is SubagentBackgroundForkEvent {
	const event = value as Partial<SubagentBackgroundForkEvent> | undefined;
	return !!event && (event.type === "async-complete" || event.type === "async-step-complete" || event.type === "control-notice") && typeof event.title === "string" && typeof event.content === "string";
}

export async function drainSubagentBackgroundQueue(
	pi: Pick<ExtensionAPI, "sendMessage">,
	config: BackgroundForkHandlersConfig | undefined,
	options: { onActivity?: () => void } = {},
): Promise<number> {
	const module = await loadBackgroundEventsModule();
	if (!module) return 0;
	const store = new module.BackgroundEventsStore();
	try {
		const pass = store.runReconcilerPass({ leaseName: "subagents", ownerId: `subagents:${process.pid}`, leaseTtlMs: 30_000, dequeueLimit: 4, source: "subagents" });
		let launched = 0;
		for (const bundle of pass.launchBundles ?? []) {
			if (bundle.source !== "subagents") continue;
			const firstEvent = bundle.events[0];
			if (!firstEvent) continue;
			const parsed = JSON.parse(await fs.promises.readFile(firstEvent.payloadPath, "utf8"));
			if (!isSubagentBackgroundForkEvent(parsed)) continue;
			await deliverBackgroundForkEvent(pi, config, parsed, { onActivity: options.onActivity, handlerId: bundle.handlerId, skipBackgroundRoute: true });
			launched += 1;
		}
		return launched;
	} finally {
		store.close();
	}
}

async function kickSubagentBackgroundQueueDrain(pi: Pick<ExtensionAPI, "sendMessage">, config: BackgroundForkHandlersConfig | undefined, options: { onActivity?: () => void } = {}, reason: string): Promise<void> {
	if (backgroundQueueDrainActive) {
		backgroundQueueDrainPending = true;
		return;
	}
	backgroundQueueDrainActive = true;
	try {
		do {
			backgroundQueueDrainPending = false;
			await drainSubagentBackgroundQueue(pi, config, options);
		} while (backgroundQueueDrainPending);
	} catch (error) {
		console.error(`[pi-subagents] Failed to drain background queue after ${reason}:`, error);
	} finally {
		backgroundQueueDrainActive = false;
	}
}

async function chargeBackgroundLineageAutoForkFromEnv(): Promise<{ allowed: boolean; reason?: string }> {
	const lineageId = process.env.PI_BACKGROUND_LINEAGE_ID?.trim();
	if (!lineageId) return { allowed: true };
	const module = await loadBackgroundEventsModule();
	if (!module) return { allowed: true };
	const store = new module.BackgroundEventsStore();
	try {
		const input = {
			lineageId,
			rootEventId: process.env.PI_BACKGROUND_EVENT_ID,
			rootWorkKey: process.env.PI_BACKGROUND_WORK_KEY,
			originHandlerId: process.env.PI_BACKGROUND_HANDLER_ID,
			forkDepth: currentBackgroundForkDepth(),
			maxForkDepth: maxBackgroundForkDepth(),
			forkable: true,
		};
		if (store.chargeAutoForkForLineage) return store.chargeAutoForkForLineage(input);
		store.upsertLineageBudget(input);
		const gate = store.canAutoFork({ lineageId, forkDepth: input.forkDepth, maxForkDepth: input.maxForkDepth, forkable: true });
		if (!gate.allowed) return gate;
		return store.chargeLineageFollowup({ lineageId, forkable: true });
	} finally {
		store.close();
	}
}

function contextCanWakeParentDirect(ctx: ExtensionContext | undefined): boolean {
	if (!ctx) return false;
	try {
		return ctx.isIdle() && !ctx.hasPendingMessages();
	} catch {
		return false;
	}
}

async function routeSubagentForkWithOptionalRouter(event: SubagentBackgroundForkEvent, resolved: ResolvedBackgroundForkHandlersConfig): Promise<{ decision: BackgroundRouterDecision; reason: string }> {
	const module = await loadBackgroundEventsModule();
	const advisoryDecision = process.env.PI_BACKGROUND_ROUTER_DECISION?.trim();
	if (!module?.runOptionalRouterDecision || !advisoryDecision) return { decision: "fork", reason: "disabled" };
	return module.runOptionalRouterDecision({
		fallback: "fork",
		railsAllowed: ["fork", "wake_main", "display"],
		ambiguous: resolved.mode === "auto" || event.type === "control-notice",
		decide: () => advisoryDecision,
	});
}

export async function deliverBackgroundForkEvent(
	pi: Pick<ExtensionAPI, "sendMessage">,
	config: BackgroundForkHandlersConfig | undefined,
	event: SubagentBackgroundForkEvent,
	options: { onActivity?: () => void; getContext?: () => ExtensionContext | undefined; handlerId?: string; skipBackgroundRoute?: boolean } = {},
): Promise<void> {
	const resolved = resolveBackgroundForkHandlersConfig(config);
	if (!resolved.enabled || backgroundForkDepthExceeded()) {
		options.onActivity?.();
		sendFallback(pi, event);
		return;
	}
	if (resolved.mode === "auto" && contextCanWakeParentDirect(options.getContext?.()) && !(await hasActiveBackgroundForkRunsForParent(event.parentSessionFile))) {
		options.onActivity?.();
		sendFallback(pi, event);
		return;
	}
	const routerDecision = await routeSubagentForkWithOptionalRouter(event, resolved).catch((error) => {
		console.error("[pi-subagents] Failed to run background fork router:", error);
		return { decision: "fork" as const, reason: "router-error" };
	});
	if (routerDecision.decision !== "fork") {
		options.onActivity?.();
		sendFallback(pi, event);
		return;
	}
	const lineageGate = await chargeBackgroundLineageAutoForkFromEnv().catch((error) => {
		console.error("[pi-subagents] Failed to charge background lineage for fork delivery:", error);
		return { allowed: false, reason: "lineage-charge-failed" };
	});
	if (!lineageGate.allowed) {
		options.onActivity?.();
		sendFallback(pi, event);
		return;
	}

	const run: BackgroundForkRun = (() => {
		const id = options.handlerId ?? makeRunId(event);
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
		const routed = options.skipBackgroundRoute ? undefined : await routeSubagentBackgroundEvent(event, run).catch((error) => {
			console.error("[pi-subagents] Failed to route background fork event through background-events:", error);
			return undefined;
		});
		if (routed && routed.disposition !== "handler-starting") {
			releaseBackgroundForkRun(run.id);
			options.onActivity?.();
			return;
		}
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
			env: buildForkHandlerEnv("subagents", run.id, {
				...process.env,
				[SUBAGENT_CHILD_ENV]: "1",
				PI_BACKGROUND_FORK_DEPTH: String(currentBackgroundForkDepth() + 1),
				PI_BACKGROUND_MAX_FORK_DEPTH: String(maxBackgroundForkDepth()),
				PI_BACKGROUND_HANDLER_ID: run.id,
				PI_BACKGROUND_EVENT_ID: subagentBackgroundEventId(event, run.id),
				PI_BACKGROUND_WORK_KEY: subagentWorkKey(event),
				PI_BACKGROUND_LINEAGE_ID: process.env.PI_BACKGROUND_LINEAGE_ID || subagentWorkKey(event),
				...(run.parentSessionFile ? { PI_BACKGROUND_PARENT_SESSION_FILE: run.parentSessionFile } : {}),
				...(run.parentIntercomTarget ? { PI_BACKGROUND_PARENT_INTERCOM_TARGET: run.parentIntercomTarget } : {}),
			}),
			onClose: (code, signal) => {
				options.onActivity?.();
				const status = code === 0 ? "complete" : "failed";
				run.status = status;
				run.endedAt = Date.now();
				run.exitCode = code;
				run.signal = signal;
				run.finishSource = "close";
				void (async () => {
					await completeBackgroundHandler(run).catch((error) => {
						console.error("[pi-subagents] Failed to complete background event handler:", error);
					});
					await kickSubagentBackgroundQueueDrain(pi, config, { onActivity: options.onActivity }, `handler ${run.id} finished`);
				})();
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
			await failBackgroundHandlerLaunch(run.id, launch.error).catch((error) => {
				console.error("[pi-subagents] Failed to compensate background event launch failure:", error);
			});
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
		await markBackgroundHandlerRunning(run).catch((error) => {
			console.error("[pi-subagents] Failed to mark background event handler running:", error);
		});
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
		await failBackgroundHandlerLaunch(run.id, error).catch((compensateError) => {
			console.error("[pi-subagents] Failed to compensate background event startup failure:", compensateError);
		});
		await patchPersistedRun(run.id, { status: "failed", endedAt: run.endedAt, error: run.error }).catch((patchError) => {
			console.error("[pi-subagents] Failed to persist background fork handler startup failure:", patchError);
		});
		releaseBackgroundForkRun(run.id);
		options.onActivity?.();
		console.error("[pi-subagents] Failed to start background fork handler:", error);
		sendFallback(pi, event);
	}
}
