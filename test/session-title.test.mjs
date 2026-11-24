// Behaviour of session_title, exercised through pi's real extension loader and session manager.
// The session API the runner binds at session start is wired to a real in-memory SessionManager,
// so titles land in the session the same way they do in a live thread.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, SessionManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("..", import.meta.url));
const TOOL = "session_title";
const ENTRY = "session-title";

async function setup({ name } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "session-title-agent-"));
	const { extensions, errors, runtime } = await discoverAndLoadExtensions(
		[join(root, "extensions/session-title.ts")],
		root,
		agentDir,
	);
	assert.deepEqual(errors, []);
	const extension = extensions[0];

	const session = SessionManager.inMemory(root);
	if (name) session.appendSessionInfo(name);

	const host = { session, names: [], entries: [], messages: [], notifications: [] };
	host.ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: session,
		isIdle: () => true,
		ui: { notify: (message, type) => host.notifications.push({ message, type }) },
	};

	// pi's own session name and entries, backed by the real session manager.
	runtime.setSessionName = (value) => {
		session.appendSessionInfo(value);
		host.names.push(value);
	};
	runtime.getSessionName = () => session.getSessionName();
	runtime.appendEntry = (customType, data) => {
		session.appendCustomEntry(customType, data);
		host.entries.push({ customType, data });
	};
	runtime.sendUserMessage = (content, options) => {
		host.messages.push({ content, options });
	};

	return {
		host,
		runtime,
		tool: extension.tools.get(TOOL).definition,
		command: extension.commands.get("title"),
		beforeAgentStart: extension.handlers.get("before_agent_start")[0],
	};
}

function agentStarts(selectedTools = ["read", "bash"]) {
	return {
		type: "before_agent_start",
		messageType: "user",
		prompt: "hi",
		systemPrompt: "",
		systemPromptOptions: { selectedTools, sections: {} },
	};
}

/** Seed a real user message so the fallback has something to name the session after. */
function withUserMessage(host, text) {
	host.session.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
	return host;
}

async function title(tool, ctx, params) {
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("registers session_title as an inactive tool whose guidelines name it", async () => {
	const { tool } = await setup();
	assert.equal(tool.name, TOOL);
	assert.equal(tool.defaultActive, false);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["title", "task"]);
	assert.ok(tool.promptGuidelines.length > 0);
	assert.ok(tool.promptGuidelines.every((line) => line.includes(TOOL)));
	assert.match(tool.promptGuidelines[0], /first action/);
});

test("declares the tool and a prompt section only while the title is provisional", async () => {
	const { beforeAgentStart } = await setup();

	const unnamed = agentStarts();
	await beforeAgentStart(unnamed, {});
	assert.deepEqual(unnamed.systemPromptOptions.selectedTools, ["read", "bash", TOOL]);
	assert.match(unnamed.systemPromptOptions.sections.session_title, /provisional/);

	// A session that already has a name (also after a manual /name) loses both again.
	const named = await setup({ name: "Fix login redirect" });
	const namedEvent = agentStarts(["read", TOOL, "bash"]);
	namedEvent.systemPromptOptions.sections.session_title = "stale";
	await named.beforeAgentStart(namedEvent, {});
	assert.deepEqual(namedEvent.systemPromptOptions.selectedTools, ["read", "bash"]);
	assert.equal(namedEvent.systemPromptOptions.sections.session_title, undefined);
});

test("the tool names the session, records title and task, and lets the model carry on", async () => {
	const { host, tool } = await setup();
	const result = await title(tool, host.ctx, {
		title: "Fix login redirect",
		task: "Return to the original page after sign-in",
	});

	const expected = "Fix login redirect — Return to the original page after sign-in";
	assert.deepEqual(host.names, [expected]);
	assert.equal(host.session.getSessionName(), expected);

	assert.equal(host.entries.length, 1);
	assert.equal(host.entries[0].customType, ENTRY);
	assert.deepEqual(host.entries[0].data, {
		title: "Fix login redirect",
		task: "Return to the original page after sign-in",
		source: "model",
		at: host.entries[0].data.at,
	});
	assert.match(host.entries[0].data.at, /^\d{4}-\d{2}-\d{2}T/);

	assert.deepEqual(result.details, {
		name: expected,
		title: "Fix login redirect",
		task: "Return to the original page after sign-in",
		source: "model",
	});
	assert.match(result.content[0].text, /Go on with the user's request/);
	assert.notEqual(result.terminate, true);
});

test("names the thread immediately from the user's first message, and the model can upgrade it", async () => {
	const { host, beforeAgentStart, tool } = await setup();

	// 1. The moment the run starts, the session is already named: no waiting on the model.
	const start = agentStarts();
	start.prompt = "our deploy pipeline keeps failing on the staging branch";
	await beforeAgentStart(start, host.ctx);
	assert.equal(host.session.getSessionName(), "our deploy pipeline keeps failing on the staging branch");
	assert.equal(host.entries.at(-1).data.source, "fallback");
	// The tool is still offered for this run so the model can improve on it.
	assert.ok(start.systemPromptOptions.selectedTools.includes(TOOL));

	// 2. The model replaces it with a better title during that run.
	await title(tool, host.ctx, { title: "Fix staging deploy pipeline", task: "Find why staging deploys fail" });
	assert.equal(host.session.getSessionName(), "Fix staging deploy pipeline — Find why staging deploys fail");

	// 3. The next run is already titled, so the tool and section are gone.
	const next = agentStarts(["read", TOOL, "bash"]);
	next.prompt = "thanks, now also check prod";
	await beforeAgentStart(next, host.ctx);
	assert.deepEqual(next.systemPromptOptions.selectedTools, ["read", "bash"]);
	assert.equal(host.session.getSessionName(), "Fix staging deploy pipeline — Find why staging deploys fail");
});

test("a run started without a user prompt still gets named from the session's first message", async () => {
	const { host, beforeAgentStart } = await setup();
	withUserMessage(host, "the login page bounces me back to the start after I sign in");

	const custom = agentStarts();
	custom.messageType = "custom";
	custom.message = { role: "custom", customType: "x", content: [], timestamp: Date.now() };
	await beforeAgentStart(custom, host.ctx);
	assert.equal(host.session.getSessionName(), "the login page bounces me back to the start after I sign in");
});

test("a title without a task becomes the plain session name", async () => {
	const { host, tool } = await setup();
	await title(tool, host.ctx, { title: "Draft Q3 roadmap" });
	assert.deepEqual(host.names, ["Draft Q3 roadmap"]);
	assert.equal(host.entries[0].data.task, "");
});

test("titles are cleaned: whitespace collapsed, length bounded, empty rejected", async () => {
	const { host, tool } = await setup();
	const long = "x".repeat(200);

	await title(tool, host.ctx, { title: "  Fix\n\nlogin\t redirect  ", task: `  ${long}  ` });
	assert.equal(host.names[0], `Fix login redirect — ${"x".repeat(99)}…`);
	assert.equal(host.entries[0].data.title, "Fix login redirect");

	await title(tool, host.ctx, { title: long });
	assert.equal(host.names[1], `${"x".repeat(59)}…`);

	await assert.rejects(title(tool, host.ctx, { title: "   " }), /must not be empty/);
	assert.equal(host.names.length, 2);
});

test("an aborted call does not name the session", async () => {
	const { host, tool } = await setup();
	const aborted = AbortSignal.abort(new Error("user pressed escape"));
	await tool.execute("call-1", { title: "Ignored" }, aborted, undefined, host.ctx);
	assert.deepEqual(host.names, []);
	assert.equal(host.session.getSessionName(), undefined);
});

test("/title shows the current title and task", async () => {
	const { host, tool, command } = await setup();
	await command.handler("", host.ctx);
	assert.match(host.notifications.at(-1).message, /No session title yet/);

	await title(tool, host.ctx, { title: "Fix login redirect", task: "Return to the original page" });
	await command.handler("", host.ctx);
	assert.equal(host.notifications.at(-1).message, "Title: Fix login redirect · Task: Return to the original page");
});

test("/title <title> renames and keeps the task; /title task <text> changes only the task", async () => {
	const { host, tool, command } = await setup();
	await title(tool, host.ctx, { title: "Fix login redirect", task: "Return to the original page" });

	await command.handler("Fix logout redirect", host.ctx);
	assert.equal(host.names.at(-1), "Fix logout redirect — Return to the original page");
	assert.equal(host.entries.at(-1).data.source, "command");
	assert.match(host.notifications.at(-1).message, /Session title: Fix logout redirect/);

	await command.handler("task   Clear the session cookie first", host.ctx);
	assert.equal(host.names.at(-1), "Fix logout redirect — Clear the session cookie first");
	assert.equal(host.entries.at(-1).data.title, "Fix logout redirect");
});

test("/title task works on a session named only with /name", async () => {
	const { host, command } = await setup({ name: "Hand-typed name" });
	await command.handler("task Add the task line", host.ctx);
	assert.equal(host.names.at(-1), "Hand-typed name — Add the task line");
});

test("/title auto asks the model and declares the tool for exactly one run", async () => {
	const { host, command, beforeAgentStart } = await setup({ name: "Old title" });

	await command.handler("auto", host.ctx);
	assert.equal(host.messages.length, 1);
	assert.match(host.messages[0].content, /call session_title once/);

	const next = agentStarts();
	await beforeAgentStart(next, {});
	assert.deepEqual(next.systemPromptOptions.selectedTools, ["read", "bash", TOOL]);

	const later = agentStarts(["read", "bash", TOOL]);
	await beforeAgentStart(later, {});
	assert.deepEqual(later.systemPromptOptions.selectedTools, ["read", "bash"]);
});

test("/title auto queues with followUp delivery while streaming, and resets when sending fails", async () => {
	const busy = await setup({ name: "Old title" });
	busy.host.ctx.isIdle = () => false;
	await busy.command.handler("auto", busy.host.ctx);
	assert.deepEqual(busy.host.messages[0].options, { deliverAs: "followUp" });

	const idle = await setup({ name: "Old title" });
	await idle.command.handler("auto", idle.host.ctx);
	assert.equal(idle.host.messages[0].options, undefined); // idle: sent immediately

	const failing = await setup({ name: "Old title" });
	failing.runtime.sendUserMessage = () => {
		throw new Error("agent is streaming");
	};
	await assert.rejects(failing.command.handler("auto", failing.host.ctx), /streaming/);
	// The one-run exposure was rolled back, so the next request does not see the tool.
	const next = agentStarts();
	await failing.beforeAgentStart(next, {});
	assert.deepEqual(next.systemPromptOptions.selectedTools, ["read", "bash"]);
});

test("/title completions cover auto and task", async () => {
	const { command } = await setup();
	assert.deepEqual(command.getArgumentCompletions("a").map((item) => item.value), ["auto"]);
	assert.equal(command.getArgumentCompletions("zz"), null);
});
