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

export function resolveForkParentSessionFile(): string | undefined {
	return envValue(FORK_PARENT_SESSION_FILE_ENVS);
}

export function resolveForkParentSessionId(): string | undefined {
	return envValue(FORK_PARENT_SESSION_ID_ENVS);
}

export function resolveForkParentIntercomTarget(): string | undefined {
	return envValue(FORK_PARENT_INTERCOM_TARGET_ENVS);
}
