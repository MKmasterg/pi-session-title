/**
 * session_title: the assistant names every session at the start of the thread.
 *
 * While a session has no name, this extension declares one extra tool, `session_title`, to the
 * model and tells it to call that tool first. The tool writes the title through pi's own session
 * name — the text `/resume` lists instead of the first message and matches before anything else
 * when you search — and records the one-line task next to it. As soon as the session is named the
 * tool leaves the prompt again, so it costs nothing for the rest of the thread.
 *
 * `/title` shows or changes the title by hand; `/title auto` asks the model for a fresh one.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const TOOL = "session_title";
const ENTRY = "session-title";
const SEPARATOR = " — ";
const MAX_TITLE = 60;
const MAX_TASK = 100;

const parameters = Type.Object({
	title: Type.String({ description: "Short title: 3–8 words, at most 60 characters" }),
	task: Type.Optional(
		Type.String({ description: "One line on what the user wants done; at most 100 characters" }),
	),
});
type Params = Static<typeof parameters>;

type Source = "model" | "command" | "fallback";

/** Stored as a custom entry next to the session name. Not sent to the model, not rendered. */
interface TitleRecord {
	title: string;
	task: string;
	source: Source;
	at: string;
}

interface TitleDetails {
	name: string;
	title: string;
	task: string;
	source: Source;
}

/** Collapse whitespace and control characters to single spaces, then trim to `max` characters. */
function clean(text: string | undefined, max: number): string {
	const flat = (text ?? "").replace(/[\s\p{C}]+/gu, " ").trim();
	const chars = Array.from(flat);
	return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : flat;
}

function composeName(title: string, task: string): string {
	return task ? `${title}${SEPARATOR}${task}` : title;
}

/** The latest title record in the session, resolved like pi resolves the name: the last one wins. */
function latestRecord(ctx: Pick<ExtensionContext, "sessionManager">): TitleRecord | undefined {
	let record: TitleRecord | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === ENTRY) {
			record = entry.data as TitleRecord;
		}
	}
	return record;
}

/** The first thing the user asked for in this session, which is what an automatic title describes. */
function firstUserText(ctx: Pick<ExtensionContext, "sessionManager">): string {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join(" ");
		if (text.trim()) return text.trim();
	}
	return "";
}

/** Instruction shown above the conversation while the session's title is still provisional. */
const SECTION = "This thread's title is still provisional. Before answering, call the `session_title` tool once to replace it with a specific title (3–8 words, at most 60 characters) and a one-line summary of what the user wants done.";

export default function (pi: ExtensionAPI) {
	/** Set by `/title auto`: declare the tool for one run although the session already has a name. */
	let exposeOnce = false;

	function record(title: string, task: string, source: Source): TitleDetails {
		const name = composeName(title, task);
		pi.setSessionName(name);
		pi.appendEntry(ENTRY, { title, task, source, at: new Date().toISOString() } satisfies TitleRecord);
		return { name, title, task, source };
	}

	// Name the thread the moment it starts, and declare the tool only while it can still be used.
	//
	// The title is set here rather than by the model because the model does not reliably call a
	// tool on the first turn — it reads a trivial-looking prompt as "no tools needed". Naming the
	// thread from the user's opening request is deterministic, instant, and needs no extra request;
	// the tool then lets the model replace it with a better title during that same run. Pi diffs
	// the prompt against what the model already has, so a named session adds nothing after the
	// first request and costs a single patch that drops the tool again.
	pi.on("before_agent_start", (event, ctx) => {
		const named = pi.getSessionName();
		const expose = exposeOnce || !named;
		exposeOnce = false;

		if (!named) {
			const text = event.messageType === "user" ? event.prompt : firstUserText(ctx);
			if (text.trim()) record(clean(text, MAX_TITLE), "", "fallback");
		}

		const tools = event.systemPromptOptions.selectedTools;
		const at = tools.indexOf(TOOL);
		if (expose && at === -1) tools.push(TOOL);
		else if (!expose && at !== -1) tools.splice(at, 1);

		// A rules bullet alone is easy for the model to skip on a trivial prompt, so state it as a
		// section of its own while the title is provisional. Removing the key removes the section.
		if (expose) event.systemPromptOptions.sections.session_title = SECTION;
		else delete event.systemPromptOptions.sections.session_title;
	});

	pi.registerTool({
		name: TOOL,
		label: "Session title",
		description:
			"Record a title and a one-line task for the current session. The title is what /resume lists instead of the first message and what it matches first when you search. Available only while the session has no title, or right after /title auto.",
		promptSnippet: "Name this session with a short title and a one-line task, shown in /resume",
		promptGuidelines: [
			"session_title is declared only while this session's title is still provisional. Call it once, as your very first action and before answering, with a concise, specific title (3–8 words, at most 60 characters) and a one-line summary of what the user wants done. This applies to every request, including short or trivial ones.",
			"Write session_title titles like bug-tracker summaries that name the project or component and the goal, using the words someone would later search for; do not start them with generic words such as \"Task\" or \"Session\".",
		],
		defaultActive: false,
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			// An aborted run must not leave a half-processed title behind.
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: { name: "", title: "", task: "", source: "model" } };
			}
			const title = clean(params.title, MAX_TITLE);
			if (!title) throw new Error("title must not be empty");
			const details = record(title, clean(params.task, MAX_TASK), "model");
			return {
				content: [{ type: "text", text: `Session titled "${details.name}". Go on with the user's request.` }],
				details,
			};
		},

		renderCall(args, theme) {
			const title = clean(args?.title, MAX_TITLE);
			return new Text(theme.fg("toolTitle", theme.bold(`${TOOL} `)) + theme.fg("accent", title), 0, 0);
		},

		renderResult(result, _options, theme) {
			const task = (result.details as TitleDetails | undefined)?.task;
			return new Text(theme.fg("success", "✓") + (task ? ` ${theme.fg("dim", task)}` : ""), 0, 0);
		},
	});

	pi.registerCommand("title", {
		description: "Show or change this session's title (/title <new title> | task <text> | auto)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "auto", label: "auto", description: "Ask the model to re-title this session from the whole conversation" },
				{ value: "task", label: "task", description: "Change only the task line" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			if (!arg) {
				const name = pi.getSessionName();
				if (!name) {
					ctx.ui.notify("No session title yet. Use /title <title>, or /title auto to ask the model.", "info");
					return;
				}
				const record = latestRecord(ctx);
				ctx.ui.notify(`Title: ${record?.title ?? name}${record?.task ? ` · Task: ${record.task}` : ""}`, "info");
				return;
			}

			if (arg === "auto" || arg === "regenerate") {
				exposeOnce = true;
				try {
					pi.sendUserMessage(
						"Re-title this session: call session_title once with a concise title (at most 60 characters) and a one-line task summary that reflect the whole conversation so far, then reply with just the new title.",
						ctx.isIdle() ? undefined : { deliverAs: "followUp" },
					);
				}
				catch (error) {
					exposeOnce = false;
					throw error;
				}
				return;
			}

			const task = arg.match(/^task\s+([\s\S]+)$/);
			if (task) {
				const title = latestRecord(ctx)?.title ?? pi.getSessionName();
				if (!title) {
					ctx.ui.notify("No session title yet. Use /title <title> or /title auto.", "warning");
					return;
				}
				ctx.ui.notify(`Session task: ${record(title, clean(task[1], MAX_TASK), "command").name}`, "info");
				return;
			}

			const title = clean(arg, MAX_TITLE);
			if (!title) {
				ctx.ui.notify("Usage: /title <new title>", "warning");
				return;
			}
			ctx.ui.notify(`Session title: ${record(title, latestRecord(ctx)?.task ?? "", "command").name}`, "info");
		},
	});
}
