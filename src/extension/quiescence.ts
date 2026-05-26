import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentRunMode, SubagentState } from "../shared/types.ts";
import { listActiveBackgroundForkRunsForParent, type BackgroundForkRunSummary } from "../runs/background/fork-handler.ts";

export interface ActiveSubagentRunSummary {
	runId: string;
	kind: "foreground" | "async";
	mode?: SubagentRunMode;
	status?: AsyncJobState["status"] | "running";
	agents?: string[];
	pid?: number;
	startedAt?: number;
	updatedAt?: number;
}

export interface SubagentParentActivityStatus {
	/** True only when the parent agent is idle, no parent messages are queued, and no subagent-owned work is outstanding. */
	quiescent: boolean;
	/** Monotonic in-process activity generation for subagent-owned state transitions observed by this parent. */
	activityGeneration: number;
	/** True when the main parent agent turn is currently active/streaming. */
	mainAgentActive: boolean;
	/** True when Pi already has queued parent messages waiting to be delivered. */
	pendingMessages: boolean;
	/** Current parent session file used to scope persisted subagent fork handlers. */
	parentSessionFile?: string;
	/** Foreground or async subagent runs owned by this extension instance that are not terminal. */
	activeSubagentRuns: ActiveSubagentRunSummary[];
	/** Persisted subagent background fork handlers for this parent session that are still starting/running. */
	activeBackgroundForkHandlers: BackgroundForkRunSummary[];
}

export interface SubagentParentActivityOptions {
	/** Override parent session file scoping; defaults to ctx.sessionManager.getSessionFile(). */
	parentSessionFile?: string | null;
}

export interface WaitForSubagentParentQuiescenceOptions extends SubagentParentActivityOptions {
	/** How long the system must remain quiescent without in-process subagent activity before resolving. Defaults to 250ms. */
	stableMs?: number;
	/** Maximum time to wait before rejecting. Defaults to 30s. */
	timeoutMs?: number;
	/** Fallback reconcile interval for persisted fork handlers whose completion may be observed only through disk. Defaults to stableMs. */
	recheckMs?: number;
	/** Optional abort signal for callers that are tied to an active parent turn. */
	signal?: AbortSignal;
}

type QuiescenceContext = Pick<ExtensionContext, "isIdle" | "hasPendingMessages" | "sessionManager">;

interface ActivityMonitor {
	generation: number;
	emitter: EventEmitter;
}

const monitors = new WeakMap<SubagentState, ActivityMonitor>();

function getMonitor(state: SubagentState): ActivityMonitor {
	let monitor = monitors.get(state);
	if (!monitor) {
		monitor = { generation: 0, emitter: new EventEmitter() };
		monitors.set(state, monitor);
	}
	return monitor;
}

export function markSubagentActivity(state: SubagentState): number {
	const monitor = getMonitor(state);
	monitor.generation += 1;
	monitor.emitter.emit("activity", monitor.generation);
	return monitor.generation;
}

export function getSubagentActivityGeneration(state: SubagentState): number {
	return getMonitor(state).generation;
}

function isOutstandingAsyncJob(job: AsyncJobState): boolean {
	return job.status === "queued" || job.status === "running" || job.status === "paused";
}

function summarizeAsyncJob(job: AsyncJobState): ActiveSubagentRunSummary {
	return {
		runId: job.asyncId,
		kind: "async",
		mode: job.mode,
		status: job.status,
		agents: job.agents,
		pid: job.pid,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
	};
}

function summarizeForegroundRun(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): ActiveSubagentRunSummary {
	return {
		runId: control.runId,
		kind: "foreground",
		mode: control.mode,
		status: "running",
		agents: control.currentAgent ? [control.currentAgent] : undefined,
		startedAt: control.startedAt,
		updatedAt: control.updatedAt,
	};
}

function getParentSessionFile(ctx: QuiescenceContext, options: SubagentParentActivityOptions): string | undefined {
	if (options.parentSessionFile !== undefined) return options.parentSessionFile ?? undefined;
	return ctx.sessionManager.getSessionFile() ?? undefined;
}

export async function getSubagentParentActivityStatus(
	ctx: QuiescenceContext,
	state: SubagentState,
	options: SubagentParentActivityOptions = {},
): Promise<SubagentParentActivityStatus> {
	const parentSessionFile = getParentSessionFile(ctx, options);
	const activityGeneration = getSubagentActivityGeneration(state);
	const activeSubagentRuns = [
		...Array.from(state.foregroundControls.values()).map(summarizeForegroundRun),
		...Array.from(state.asyncJobs.values()).filter(isOutstandingAsyncJob).map(summarizeAsyncJob),
	];
	const activeBackgroundForkHandlers = await listActiveBackgroundForkRunsForParent(parentSessionFile);
	const mainAgentActive = !ctx.isIdle();
	const pendingMessages = ctx.hasPendingMessages();
	return {
		quiescent: !mainAgentActive && !pendingMessages && activeSubagentRuns.length === 0 && activeBackgroundForkHandlers.length === 0,
		activityGeneration,
		mainAgentActive,
		pendingMessages,
		parentSessionFile,
		activeSubagentRuns,
		activeBackgroundForkHandlers,
	};
}

export async function isSubagentParentQuiescent(
	ctx: QuiescenceContext,
	state: SubagentState,
	options: SubagentParentActivityOptions = {},
): Promise<boolean> {
	return (await getSubagentParentActivityStatus(ctx, state, options)).quiescent;
}

export async function waitForSubagentParentQuiescence(
	ctx: QuiescenceContext,
	state: SubagentState,
	options: WaitForSubagentParentQuiescenceOptions = {},
): Promise<SubagentParentActivityStatus> {
	const stableMs = Math.max(0, options.stableMs ?? 250);
	const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
	const recheckMs = Math.max(10, options.recheckMs ?? Math.max(stableMs, 50));
	const monitor = getMonitor(state);

	return await new Promise<SubagentParentActivityStatus>((resolve, reject) => {
		let settled = false;
		let checking = false;
		let pendingCheck = false;
		let stableTimer: ReturnType<typeof setTimeout> | undefined;
		let recheckTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			monitor.emitter.off("activity", onActivity);
			options.signal?.removeEventListener("abort", onAbort);
			if (stableTimer) clearTimeout(stableTimer);
			if (recheckTimer) clearTimeout(recheckTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};
		const finish = (status: SubagentParentActivityStatus) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(status);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const scheduleCheck = (delayMs = 0) => {
			if (settled) return;
			if (stableTimer) {
				clearTimeout(stableTimer);
				stableTimer = undefined;
			}
			if (recheckTimer) clearTimeout(recheckTimer);
			recheckTimer = setTimeout(() => {
				recheckTimer = undefined;
				void check();
			}, delayMs);
			recheckTimer.unref?.();
		};
		const scheduleFallbackRecheck = () => scheduleCheck(recheckMs);
		const onActivity = () => scheduleCheck(0);
		const onAbort = () => fail(new Error("waitForSubagentParentQuiescence aborted"));
		const checkStableAfterDelay = (generation: number) => {
			if (stableTimer) clearTimeout(stableTimer);
			stableTimer = setTimeout(() => {
				stableTimer = undefined;
				if (getSubagentActivityGeneration(state) !== generation) {
					scheduleCheck(0);
					return;
				}
				void check(generation);
			}, stableMs);
			stableTimer.unref?.();
		};
		const check = async (stableGeneration?: number): Promise<void> => {
			if (settled) return;
			if (checking) {
				pendingCheck = true;
				return;
			}
			checking = true;
			try {
				const before = getSubagentActivityGeneration(state);
				const status = await getSubagentParentActivityStatus(ctx, state, options);
				const after = getSubagentActivityGeneration(state);
				if (!status.quiescent || before !== after) {
					scheduleFallbackRecheck();
					return;
				}
				if (stableGeneration === undefined) {
					checkStableAfterDelay(after);
					return;
				}
				if (stableGeneration === after) {
					finish(status);
					return;
				}
				scheduleCheck(0);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			} finally {
				checking = false;
				if (pendingCheck && !settled) {
					pendingCheck = false;
					scheduleCheck(0);
				}
			}
		};

		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		monitor.emitter.on("activity", onActivity);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		timeoutTimer = setTimeout(() => fail(new Error(`Timed out waiting ${timeoutMs}ms for subagent parent quiescence`)), timeoutMs);
		timeoutTimer.unref?.();
		void check();
	});
}
