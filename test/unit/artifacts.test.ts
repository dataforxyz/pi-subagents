import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, it } from "node:test";
import { cleanupAllArtifactDirs } from "../../src/shared/artifacts.ts";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
	if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("cleans session artifacts under PI_CODING_AGENT_DIR", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-dir-"));
	tempDirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const artifactsDir = path.join(agentDir, "sessions", "session-a", "subagent-artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true });
	const oldFile = path.join(artifactsDir, "old-output.md");
	fs.writeFileSync(oldFile, "old artifact");
	const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
	fs.utimesSync(oldFile, oldTime, oldTime);

	cleanupAllArtifactDirs(1);

	assert.equal(fs.existsSync(oldFile), false);
	assert.equal(fs.existsSync(path.join(artifactsDir, ".last-cleanup")), true);
});
