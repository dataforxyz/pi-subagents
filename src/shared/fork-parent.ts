export type ForkParentRouting = "auto" | "main" | "current";

const FORK_PARENT_SESSION_FILE_ENVS = [
	"PI_RETURN_ON_PARENT_SESSION_FILE",
	"PI_INTERCOM_PARENT_SESSION_FILE",
] as const;

const FORK_PARENT_SESSION_ID_ENVS = [
	"PI_RETURN_ON_PARENT_SESSION_ID",
	"PI_INTERCOM_PARENT_SESSION_ID",
] as const;

const FORK_PARENT_INTERCOM_TARGET_ENVS = [
	"PI_RETURN_ON_PARENT_INTERCOM_TARGET",
	"PI_INTERCOM_PARENT_INTERCOM_TARGET",
] as const;

function envValue(names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

export function hasForkParent(): boolean {
	return !!(envValue(FORK_PARENT_SESSION_FILE_ENVS) || envValue(FORK_PARENT_SESSION_ID_ENVS) || envValue(FORK_PARENT_INTERCOM_TARGET_ENVS));
}

export function normalizeForkParentRouting(value: unknown): ForkParentRouting {
	if (value === undefined || value === null || value === "") return "auto";
	if (value === "auto" || value === "main" || value === "current") return value;
	throw new Error("parent must be one of 'auto', 'main', or 'current'");
}

export function shouldUseForkParent(route: ForkParentRouting, effectiveAsync: boolean): boolean {
	if (route === "main") return true;
	if (route === "current") return false;
	return effectiveAsync && hasForkParent();
}

export function resolveForkParentSessionFile(useForkParent = true): string | undefined {
	return useForkParent ? envValue(FORK_PARENT_SESSION_FILE_ENVS) : undefined;
}

export function resolveForkParentSessionId(useForkParent = true): string | undefined {
	return useForkParent ? envValue(FORK_PARENT_SESSION_ID_ENVS) : undefined;
}

export function resolveForkParentIntercomTarget(useForkParent = true): string | undefined {
	return useForkParent ? envValue(FORK_PARENT_INTERCOM_TARGET_ENVS) : undefined;
}
