import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diagnoseIntercomBridge, type IntercomBridgeDiagnostic, resolveIntercomSessionTarget } from "../intercom/intercom-bridge.ts";
import type { CompanionSuggestionPackage, CompanionSuggestionSurface, ExtensionConfig, SubagentState } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";
import { updateConfig } from "./config.ts";

const PROMPT_TEMPLATE_MODEL: CompanionSuggestionPackage = "pi-prompt-template-model";
const PI_INTERCOM: CompanionSuggestionPackage = "pi-intercom";
const COMPANION_PACKAGES = [PI_INTERCOM, PROMPT_TEMPLATE_MODEL] as const;
const DEFAULT_SURFACES: CompanionSuggestionSurface[] = ["session_start", "list", "doctor"];

interface SourceInfoLike {
	path?: unknown;
	source?: unknown;
	baseDir?: unknown;
}

interface NamedRuntimeResource {
	name?: unknown;
	sourceInfo?: unknown;
}

interface IntercomConfigStatus {
	enabled: boolean;
	error?: string;
}

export interface CompanionPackageStatus {
	packageName: CompanionSuggestionPackage;
	active: boolean;
	disabled: boolean;
	dismissed: boolean;
	surfaces: Set<CompanionSuggestionSurface>;
	installCommand: string;
	benefit: string;
	statusSource: string;
	reason: string;
	details?: string[];
	intercomBridge?: IntercomBridgeDiagnostic;
}

interface CollectCompanionStatusesInput {
	pi: Pick<ExtensionAPI, "getAllTools" | "getCommands">;
	config: ExtensionConfig;
	cwd: string;
	context?: "fresh" | "fork";
	orchestratorTarget?: string;
	workspaceKey?: string;
	fast?: boolean;
}

interface CompanionMessageInput {
	pi: Pick<ExtensionAPI, "sendMessage">;
	ctx: ExtensionContext;
	state: SubagentState;
	statuses: CompanionPackageStatus[];
}

function commandBaseName(name: string): string {
	return name.replace(/:\d+$/, "");
}

function sourceValueMatchesPackage(value: string, packageName: CompanionSuggestionPackage): boolean {
	const normalized = value.replaceAll("\\", "/").toLowerCase();
	const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[/:@])${escaped}($|[/:@])`).test(normalized);
}

function sourceInfoMatchesPackage(sourceInfo: unknown, packageName: CompanionSuggestionPackage): boolean {
	if (!sourceInfo || typeof sourceInfo !== "object" || Array.isArray(sourceInfo)) return false;
	const info = sourceInfo as SourceInfoLike;
	return [info.path, info.source, info.baseDir]
		.some((value) => typeof value === "string" && sourceValueMatchesPackage(value, packageName));
}

function namedResourcesFrom(value: unknown): NamedRuntimeResource[] {
	return Array.isArray(value) ? value.filter((entry): entry is NamedRuntimeResource => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function hasPackageCommand(pi: Pick<ExtensionAPI, "getCommands">, packageName: CompanionSuggestionPackage, commandName: string): boolean {
	return namedResourcesFrom(pi.getCommands()).some((command) =>
		typeof command.name === "string"
		&& commandBaseName(command.name) === commandName
		&& sourceInfoMatchesPackage(command.sourceInfo, packageName)
	);
}

function hasPackageTool(pi: Pick<ExtensionAPI, "getAllTools">, packageName: CompanionSuggestionPackage, toolName: string): boolean {
	return namedResourcesFrom(pi.getAllTools()).some((tool) =>
		typeof tool.name === "string"
		&& commandBaseName(tool.name) === toolName
		&& sourceInfoMatchesPackage(tool.sourceInfo, packageName)
	);
}

function nearestGitRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function companionWorkspaceKey(cwd: string): string {
	return nearestGitRoot(cwd) ?? path.resolve(cwd);
}

function normalizeSurface(value: unknown): CompanionSuggestionSurface | undefined {
	return value === "session_start" || value === "list" || value === "doctor" ? value : undefined;
}

function packageConfig(config: ExtensionConfig, packageName: CompanionSuggestionPackage) {
	const companionConfig = config.companionSuggestions;
	if (companionConfig === false) return { enabled: false, surfaces: new Set<CompanionSuggestionSurface>(), dismissed: false };
	const packageSpecific = companionConfig?.packages?.[packageName];
	const surfaces = Array.isArray(packageSpecific?.surfaces)
		? packageSpecific.surfaces.map(normalizeSurface).filter((surface): surface is CompanionSuggestionSurface => Boolean(surface))
		: DEFAULT_SURFACES;
	return {
		enabled: companionConfig?.enabled !== false && packageSpecific?.enabled !== false,
		surfaces: new Set(surfaces),
		dismissedConfig: packageSpecific?.dismissed,
	};
}

function isDismissed(config: ExtensionConfig, packageName: CompanionSuggestionPackage, workspaceKey: string): boolean {
	const dismissed = packageConfig(config, packageName).dismissedConfig;
	return dismissed?.user === true || dismissed?.workspaces?.includes(workspaceKey) === true;
}

function readPiIntercomConfigStatus(agentDir = getAgentDir()): IntercomConfigStatus {
	const configPath = path.join(agentDir, "intercom", "config.json");
	if (!fs.existsSync(configPath)) return { enabled: true };
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { enabled: true };
		return { enabled: (parsed as { enabled?: unknown }).enabled !== false };
	} catch (error) {
		return { enabled: true, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function promptTemplateModelStatus(input: CollectCompanionStatusesInput, workspaceKey: string): CompanionPackageStatus {
	const config = packageConfig(input.config, PROMPT_TEMPLATE_MODEL);
	const active = hasPackageCommand(input.pi, PROMPT_TEMPLATE_MODEL, "prompt-tool");
	return {
		packageName: PROMPT_TEMPLATE_MODEL,
		active,
		disabled: !config.enabled,
		dismissed: isDismissed(input.config, PROMPT_TEMPLATE_MODEL, workspaceKey),
		surfaces: config.surfaces,
		installCommand: "pi install npm:pi-prompt-template-model",
		benefit: "reusable prompt-template workflows with model/thinking/skill/subagent frontmatter",
		statusSource: "active runtime command: prompt-tool",
		reason: active ? "active" : "prompt-tool command from pi-prompt-template-model is not active in this session",
	};
}

function piIntercomStatus(input: CollectCompanionStatusesInput, workspaceKey: string): CompanionPackageStatus {
	const config = packageConfig(input.config, PI_INTERCOM);
	const parentToolActive = hasPackageTool(input.pi, PI_INTERCOM, "intercom");
	const intercomConfig = readPiIntercomConfigStatus();
	const bridge = diagnoseIntercomBridge({
		config: input.config.intercomBridge,
		context: input.context,
		orchestratorTarget: input.orchestratorTarget,
		cwd: input.cwd,
		globalNpmRoot: input.fast ? null : undefined,
	});
	const active = parentToolActive && intercomConfig.enabled && (!bridge.wantsIntercom || bridge.piIntercomAvailable);
	const details = [
		`parent runtime tool: ${parentToolActive ? "active" : "inactive"}`,
		`bridge: ${bridge.active ? "active" : "inactive"}${bridge.reason ? ` (${bridge.reason})` : ""}`,
		...(intercomConfig.error ? [`intercom config warning: ${intercomConfig.error}; runtime assumes enabled`] : []),
	];
	return {
		packageName: PI_INTERCOM,
		active,
		disabled: !config.enabled,
		dismissed: isDismissed(input.config, PI_INTERCOM, workspaceKey),
		surfaces: config.surfaces,
		installCommand: "pi install npm:pi-intercom",
		benefit: "live supervisor decisions, progress updates, and grouped result delivery",
		statusSource: "active runtime intercom tool plus intercom bridge diagnostics",
		reason: active
			? "active"
			: !intercomConfig.enabled
				? "pi-intercom config is disabled"
				: parentToolActive
					? "pi-intercom is active in the parent runtime, but child bridge discovery is not ready"
					: "intercom tool from pi-intercom is not active in this session",
		details,
		intercomBridge: bridge,
	};
}

export function collectCompanionStatuses(input: CollectCompanionStatusesInput): CompanionPackageStatus[] {
	const workspaceKey = input.workspaceKey ?? companionWorkspaceKey(input.cwd);
	return [
		piIntercomStatus(input, workspaceKey),
		promptTemplateModelStatus(input, workspaceKey),
	];
}

function shouldRecommend(status: CompanionPackageStatus, surface: CompanionSuggestionSurface): boolean {
	if (status.disabled || status.dismissed || status.active || !status.surfaces.has(surface)) return false;
	if (status.packageName === PI_INTERCOM && status.reason === "pi-intercom config is disabled" && surface !== "doctor") return false;
	if (status.packageName === PI_INTERCOM && status.intercomBridge?.wantsIntercom === false && surface !== "doctor") return false;
	return true;
}

export function buildCompanionListLines(statuses: CompanionPackageStatus[]): string[] {
	const recommended = statuses.filter((status) => shouldRecommend(status, "list"));
	if (recommended.length === 0) return [];
	const lines = ["Recommended companions:"];
	for (const status of recommended) {
		lines.push(`- ${status.packageName} is not active in this session.`);
		lines.push(`  Benefit: ${status.benefit}.`);
		lines.push(`  Run: ${status.installCommand}, then restart Pi or /reload.`);
		lines.push(`  Hide: /subagents-companions hide ${status.packageName} workspace`);
	}
	return lines;
}

export function buildCompanionDoctorLines(statuses: CompanionPackageStatus[]): string[] {
	const lines = ["Companion packages"];
	for (const status of statuses) {
		const hidden = status.dismissed ? " recommendation hidden by config" : "";
		const disabled = status.disabled ? " disabled by config" : "";
		lines.push(`- ${status.packageName}: ${status.active ? "active" : "inactive"}${hidden}${disabled}`);
		lines.push(`  install: ${status.installCommand}`);
		lines.push(`  benefit: ${status.benefit}`);
		lines.push(`  status source: ${status.statusSource}`);
		lines.push(`  reason: ${status.reason}`);
		for (const detail of status.details ?? []) lines.push(`  ${detail}`);
	}
	return lines;
}

export function buildCompanionStartupMessage(statuses: CompanionPackageStatus[]): string | null {
	const recommended = statuses.filter((status) => shouldRecommend(status, "session_start"));
	if (recommended.length === 0) return null;
	const lines = [
		recommended.length === 1
			? `Recommended: install ${recommended[0]!.packageName} for pi-subagents.`
			: "Recommended: install companion packages for pi-subagents.",
		"",
	];
	for (const status of recommended) {
		lines.push(`- ${status.packageName}: ${status.benefit}.`);
		lines.push(`  Run: ${status.installCommand}`);
	}
	lines.push(
		"",
		recommended.length === 1 ? "I can help you run that install command." : "I can help you run those install commands.",
		"",
		"Or hide a recommendation:",
	);
	for (const status of recommended) {
		lines.push(`  /subagents-companions hide ${status.packageName} workspace`);
	}
	return lines.join("\n");
}

export function maybeSendCompanionStartupMessage(input: CompanionMessageInput): void {
	if (!input.ctx.hasUI || input.state.companionSuggestionStartupShown) return;
	const message = buildCompanionStartupMessage(input.statuses);
	if (!message) return;
	input.state.companionSuggestionStartupShown = true;
	input.pi.sendMessage({
		customType: "subagent_companion_suggestions",
		content: message,
		display: true,
		details: { packages: input.statuses.filter((status) => shouldRecommend(status, "session_start")).map((status) => status.packageName) },
	});
}

function parseCompanionPackage(value: string | undefined): CompanionSuggestionPackage | undefined {
	return COMPANION_PACKAGES.find((packageName) => packageName === value);
}

function packageDismissedWorkspaces(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function updateCompanionDismissal(packageName: CompanionSuggestionPackage, scope: "workspace" | "user" | "show", cwd: string): ExtensionConfig {
	const workspaceKey = companionWorkspaceKey(cwd);
	return updateConfig((current) => {
		const companionSuggestions = current.companionSuggestions === false
			? { enabled: false }
			: current.companionSuggestions ?? {};
		const packages = companionSuggestions.packages ?? {};
		const packageConfig = packages[packageName] ?? {};
		const dismissed = { ...(packageConfig.dismissed ?? {}) };
		if (scope === "user") {
			dismissed.user = true;
		} else if (scope === "workspace") {
			dismissed.workspaces = [...new Set([...packageDismissedWorkspaces(dismissed.workspaces), workspaceKey])];
		} else {
			delete dismissed.user;
			dismissed.workspaces = packageDismissedWorkspaces(dismissed.workspaces).filter((entry) => entry !== workspaceKey);
			if (dismissed.workspaces.length === 0) delete dismissed.workspaces;
		}
		return {
			...current,
			companionSuggestions: {
				...companionSuggestions,
				packages: {
					...packages,
					[packageName]: {
						...packageConfig,
						...(Object.keys(dismissed).length > 0 ? { dismissed } : { dismissed: undefined }),
					},
				},
			},
		};
	});
}

export function buildCompanionCommandStatus(statuses: CompanionPackageStatus[]): string {
	return buildCompanionDoctorLines(statuses).join("\n");
}

export function handleCompanionCommand(args: string, ctx: ExtensionContext, statuses: CompanionPackageStatus[]): { text: string; updatedConfig?: ExtensionConfig; error?: boolean } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "status") {
		return { text: buildCompanionCommandStatus(statuses) };
	}
	if (parts[0] !== "hide" && parts[0] !== "show") {
		return { text: "Usage: /subagents-companions status | hide <pi-intercom|pi-prompt-template-model> <workspace|user> | show <pi-intercom|pi-prompt-template-model>", error: true };
	}
	const packageName = parseCompanionPackage(parts[1]);
	if (!packageName) {
		return { text: "Unknown companion package. Use pi-intercom or pi-prompt-template-model.", error: true };
	}
	if (parts[0] === "show") {
		return { text: `Showing ${packageName} recommendations for this workspace again.`, updatedConfig: updateCompanionDismissal(packageName, "show", ctx.cwd) };
	}
	const scope = parts[2];
	if (scope !== "workspace" && scope !== "user") {
		return { text: "Usage: /subagents-companions hide <pi-intercom|pi-prompt-template-model> <workspace|user>", error: true };
	}
	return {
		text: scope === "user" ? `Hid ${packageName} recommendations for this user.` : `Hid ${packageName} recommendations for this workspace.`,
		updatedConfig: updateCompanionDismissal(packageName, scope, ctx.cwd),
	};
}

export function resolveCompanionOrchestratorTarget(pi: Pick<ExtensionAPI, "getSessionName">, ctx: ExtensionContext): string | undefined {
	try {
		return resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());
	} catch {
		return undefined;
	}
}
