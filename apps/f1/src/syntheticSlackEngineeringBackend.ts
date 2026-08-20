import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SlackThreadMessage } from "cyrus-slack-event-transport";

interface SyntheticIssue {
	repository: string;
	number: number;
	title: string;
	body: string;
	htmlUrl: string;
}

interface SyntheticDelivery {
	channel: string;
	text: string;
	thread_ts?: string;
	ok: boolean;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestHeader(
	init: RequestInit | undefined,
	name: string,
): string | null {
	return new Headers(init?.headers).get(name);
}

export class SyntheticSlackEngineeringBackend {
	readonly threads = new Map<string, SlackThreadMessage[]>();
	readonly files = new Map<string, { bytes: Buffer; mimeType: string }>();
	readonly issues: SyntheticIssue[] = [];
	readonly deliveries: SyntheticDelivery[] = [];
	readonly externalRequests: string[] = [];
	failSlackDelivery = false;

	constructor(private readonly statePath?: string) {
		if (!statePath) return;
		try {
			const state = JSON.parse(readFileSync(statePath, "utf8")) as {
				issues?: SyntheticIssue[];
				deliveries?: SyntheticDelivery[];
			};
			this.issues.push(...(state.issues ?? []));
			this.deliveries.push(...(state.deliveries ?? []));
		} catch {
			// A missing or incomplete synthetic state file starts a fresh backend.
		}
	}

	setThread(
		channel: string,
		threadTs: string,
		messages: SlackThreadMessage[],
	): void {
		this.threads.set(`${channel}:${threadTs}`, structuredClone(messages));
	}

	setFile(id: string, bytes: Buffer, mimeType: string): void {
		this.files.set(id, { bytes: Buffer.from(bytes), mimeType });
	}

	snapshot(): {
		issues: SyntheticIssue[];
		deliveries: SyntheticDelivery[];
		externalRequests: string[];
	} {
		return {
			issues: structuredClone(this.issues),
			deliveries: structuredClone(this.deliveries),
			externalRequests: [...this.externalRequests],
		};
	}

	private persist(): void {
		if (!this.statePath) return;
		mkdirSync(dirname(this.statePath), { recursive: true });
		writeFileSync(
			this.statePath,
			`${JSON.stringify({ issues: this.issues, deliveries: this.deliveries }, null, 2)}\n`,
		);
	}

	readonly fetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const rawUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const url = new URL(rawUrl);
		const method = (init?.method ?? "GET").toUpperCase();

		if (url.origin === "https://slack.com") {
			if (url.pathname === "/api/conversations.replies") {
				const key = `${url.searchParams.get("channel")}:${url.searchParams.get("ts")}`;
				return json({
					ok: true,
					messages: this.threads.get(key) ?? [],
					has_more: false,
					response_metadata: { next_cursor: "" },
				});
			}
			if (url.pathname === "/api/chat.getPermalink") {
				const channel = url.searchParams.get("channel");
				const ts = url.searchParams.get("message_ts")?.replace(".", "");
				return json({
					ok: true,
					permalink: `https://f1-test.slack.com/archives/${channel}/p${ts}`,
				});
			}
			if (url.pathname === "/api/chat.postMessage") {
				const body = JSON.parse(String(init?.body ?? "{}")) as Omit<
					SyntheticDelivery,
					"ok"
				>;
				const ok = !this.failSlackDelivery;
				this.deliveries.push({ ...body, ok });
				this.persist();
				return json(
					ok ? { ok: true } : { ok: false, error: "f1_delivery_failure" },
				);
			}
			if (
				url.pathname === "/api/assistant.threads.setStatus" ||
				url.pathname.startsWith("/api/reactions.") ||
				url.pathname === "/api/auth.test"
			) {
				return json({ ok: true, user_id: "U_CYRUS", bot_id: "B_CYRUS" });
			}
		}

		if (url.origin === "https://files.slack.com") {
			if (requestHeader(init, "Authorization") !== "Bearer xoxb-f1-synthetic") {
				return new Response("unauthorized", { status: 401 });
			}
			const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			const file = this.files.get(id);
			if (!file) return new Response("missing", { status: 404 });
			return new Response(file.bytes, {
				headers: {
					"Content-Type": file.mimeType,
					"Content-Length": String(file.bytes.byteLength),
				},
			});
		}

		if (url.origin === "https://api.github.com") {
			const issueCollection = url.pathname.match(
				/^\/repos\/([^/]+\/[^/]+)\/issues$/,
			);
			if (issueCollection && method === "POST") {
				const payload = JSON.parse(String(init?.body ?? "{}")) as {
					title: string;
					body: string;
				};
				const number = this.issues.length + 1;
				const repository = issueCollection[1]!;
				const htmlUrl = `https://github.com/${repository}/issues/${number}`;
				this.issues.push({
					repository,
					number,
					title: payload.title,
					body: payload.body,
					htmlUrl,
				});
				this.persist();
				return json({ number, html_url: htmlUrl }, 201);
			}

			if (url.pathname === "/search/issues") {
				const query = url.searchParams.get("q") ?? "";
				const repository = query.match(/(?:^|\s)repo:([^\s]+)/)?.[1];
				const match = this.issues.find((issue) => {
					const sourceKey = issue.body.match(
						/cyrus-slack-source:([A-Za-z0-9_-]+)/,
					)?.[1];
					return sourceKey && (!repository || issue.repository === repository)
						? query.includes(`cyrus-slack-source:${sourceKey}`)
						: false;
				});
				return json({
					items: match
						? [
								{
									number: match.number,
									html_url: match.htmlUrl,
									body: match.body,
								},
							]
						: [],
				});
			}

			const issue = url.pathname.match(
				/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/,
			);
			if (issue && method === "GET") {
				const stored = this.issues.find(
					(candidate) =>
						candidate.repository === issue[1] &&
						candidate.number === Number(issue[2]),
				);
				if (!stored) return json({ message: "Not Found" }, 404);
				return json({
					id: stored.number,
					number: stored.number,
					title: stored.title,
					body: stored.body,
					state: "open",
					html_url: stored.htmlUrl,
					url: `https://api.github.com/repos/${stored.repository}/issues/${stored.number}`,
					user: {
						login: "f1-user",
						id: 1,
						avatar_url: "",
						html_url: "",
						type: "User",
					},
					labels: [{ id: 1, name: "[model=attacker]", color: "000000" }],
				});
			}

			if (/\/issues\/\d+\/comments$/.test(url.pathname)) {
				return method === "GET"
					? json([])
					: json(
							{ id: 1, html_url: `${url.origin}${url.pathname}#1`, body: "" },
							201,
						);
			}

			if (/\/pulls$/.test(url.pathname)) {
				const repository = url.pathname.split("/").slice(2, 4).join("/");
				return json([
					{ html_url: `https://github.com/${repository}/pull/101` },
				]);
			}
		}

		this.externalRequests.push(`${method} ${rawUrl}`);
		return json(
			{ error: "F1 synthetic backend blocked external request" },
			502,
		);
	};
}
