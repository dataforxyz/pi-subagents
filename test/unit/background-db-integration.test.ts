import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultBackgroundEventsPath = path.resolve(__dirname, "../../../pi-forks-fork-router-smoke/src/background-events.ts");

async function waitForCompletedHandler(dbPath: string, handlerId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	let lastState: string | undefined;
	while (Date.now() < deadline) {
		if (fs.existsSync(dbPath)) {
			const db = new DatabaseSync(dbPath);
			try {
				const handler = db.prepare("SELECT state FROM handlers WHERE handler_id = ?").get(handlerId) as { state?: string } | undefined;
				lastState = handler?.state;
				const result = db.prepare("SELECT status FROM results WHERE handler_id = ?").get(handlerId) as { status?: string } | undefined;
				if (handler?.state === "completed" && result?.status === "complete") return;
			} finally {
				db.close();
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for completed background handler ${handlerId}; last state=${lastState ?? "missing"}`);
}

test("subagent background fork delivery drives shared background-events DB lifecycle", async (t) => {
	const backgroundEventsPath = process.env.PI_FORKS_BACKGROUND_EVENTS_MODULE ?? defaultBackgroundEventsPath;
	if (!fs.existsSync(backgroundEventsPath)) {
		t.skip(`pi-forks background-events test module not found at ${backgroundEventsPath}`);
		return;
	}

	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-subagents-bgdb-"));
	const previous = {
		PI_BACKGROUND_STATE_DIR: process.env.PI_BACKGROUND_STATE_DIR,
		PI_BACKGROUND_EVENTS_MODULE: process.env.PI_BACKGROUND_EVENTS_MODULE,
		PI_BACKGROUND_ROUTER_DECISION: process.env.PI_BACKGROUND_ROUTER_DECISION,
		PI_BACKGROUND_ROUTER_ENABLED: process.env.PI_BACKGROUND_ROUTER_ENABLED,
	};
	try {
		process.env.PI_BACKGROUND_STATE_DIR = path.join(tmp, "state");
		process.env.PI_BACKGROUND_EVENTS_MODULE = pathToFileURL(backgroundEventsPath).href;
		delete process.env.PI_BACKGROUND_ROUTER_DECISION;
		delete process.env.PI_BACKGROUND_ROUTER_ENABLED;

		const script = path.join(tmp, "stub-pi.sh");
		await fsp.writeFile(script, "#!/bin/sh\necho subagent-background-db-ok\n", "utf8");
		await fsp.chmod(script, 0o755);

		const { deliverBackgroundForkEvent } = await import("../../src/runs/background/fork-handler.ts");
		await deliverBackgroundForkEvent(
			{ sendMessage: () => {} } as never,
			{ enabled: true, mode: "always", notify: "none", triggerParentOnSummary: false, piCommand: script },
			{
				type: "async-complete",
				title: "shared db lifecycle",
				content: "done",
				cwd: process.cwd(),
				parentSessionFile: path.join(tmp, "parent.jsonl"),
				details: { runId: "subagent-bgdb-run" },
			},
		);

		const handlersFile = path.join(process.env.PI_BACKGROUND_STATE_DIR, "pi-subagents", "handlers.json");
		const handlersState = JSON.parse(await fsp.readFile(handlersFile, "utf8")) as { handlers: Array<{ id: string; status?: string }> };
		const run = handlersState.handlers.find((handler) => handler.title === "shared db lifecycle");
		assert.ok(run, "expected persisted subagent background handler");

		const dbPath = path.join(process.env.PI_BACKGROUND_STATE_DIR, "background-events.sqlite");
		await waitForCompletedHandler(dbPath, run.id);

		const db = new DatabaseSync(dbPath);
		try {
			const handler = db.prepare("SELECT source, state, root_event_id, work_key FROM handlers WHERE handler_id = ?").get(run.id) as { source: string; state: string; root_event_id: string; work_key: string };
			assert.equal(handler.source, "subagents");
			assert.equal(handler.state, "completed");
			assert.match(handler.root_event_id, /^subagents:async-complete:/);
			assert.match(handler.work_key, /^subagents:/);

			const event = db.prepare("SELECT source FROM events WHERE event_id = ?").get(handler.root_event_id) as { source: string };
			assert.equal(event.source, "subagents");

			const result = db.prepare("SELECT status, delivery_state FROM results WHERE handler_id = ?").get(run.id) as { status: string; delivery_state: string };
			assert.equal(result.status, "complete");
			assert.equal(result.delivery_state, "pending");
		} finally {
			db.close();
		}
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});
