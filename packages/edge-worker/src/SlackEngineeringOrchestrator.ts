import { createHash } from "node:crypto";

export type SlackEngineeringStatus =
	| "creating"
	| "starting"
	| "in_progress"
	| "awaiting_review"
	| "failed"
	| "stopped";
export interface SlackEngineeringRepository {
	name: string;
	fullName: string;
	routingHints: string[];
}
export interface SlackEngineeringSource {
	parentSessionId: string;
	teamId: string;
	userId: string;
	channelId: string;
	threadTs: string;
	kickoffTs: string;
	permalink: string;
	contextDirectory?: string;
	contextManifestPath?: string;
	contextTranscriptPath?: string;
	contextDirectories?: string[];
}
export interface SlackEngineeringReceipt extends SlackEngineeringSource {
	sourceKey: string;
	marker: string;
	status: SlackEngineeringStatus;
	issueRepository: string;
	title: string;
	summary: string;
	targetRepositories: string[];
	issueNumber?: number;
	issueUrl?: string;
	workItemId?: string;
	sessionId?: string;
	prUrls?: string[];
	error?: string;
}
export interface SlackEngineeringCreateInput {
	issueRepository: string;
	title: string;
	summary: string;
	targetRepositories?: string[];
}
interface Dependencies {
	repositories: () => SlackEngineeringRepository[];
	persist: (receipts: SlackEngineeringReceipt[]) => Promise<void>;
	createIssue: (input: {
		repository: string;
		title: string;
		body: string;
		marker: string;
	}) => Promise<{ number: number; url: string }>;
	findIssueByMarker: (
		repository: string,
		marker: string,
	) => Promise<{ number: number; url: string } | undefined>;
	startWorkItem: (input: {
		workItemId: string;
		repositoryFullName: string;
		issueNumber: number;
		targetRepositoryFullNames: string[];
		runnerType: "claude";
		requestId: string;
	}) => Promise<{
		workItemId?: string;
		sessionId: string;
		status:
			| "starting"
			| "in_progress"
			| "awaiting_review"
			| "failed"
			| "stopped";
	}>;
	promptWorkItem: (workItemId: string, message: string) => Promise<void>;
	stopWorkItem: (workItemId: string) => Promise<void>;
}
const TERMINAL = new Set<SlackEngineeringStatus>([
	"awaiting_review",
	"failed",
	"stopped",
]);

export function slackEngineeringSourceKey(
	source: Pick<
		SlackEngineeringSource,
		"teamId" | "channelId" | "threadTs" | "kickoffTs"
	>,
): string {
	return createHash("sha256")
		.update(
			[
				"cyrus-slack-source-v1",
				source.teamId,
				source.channelId,
				source.threadTs,
				source.kickoffTs,
			].join("\0"),
		)
		.digest("hex");
}

export class SlackEngineeringOrchestrator {
	private readonly receipts = new Map<string, SlackEngineeringReceipt>();
	private readonly threadIndex = new Map<string, string>();
	constructor(
		private readonly deps: Dependencies,
		initial: SlackEngineeringReceipt[] = [],
	) {
		for (const receipt of initial) this.index(receipt);
	}
	restore(receipts: SlackEngineeringReceipt[]): void {
		for (const receipt of receipts)
			this.index({
				...receipt,
				targetRepositories: [...receipt.targetRepositories],
				contextDirectories: receipt.contextDirectories && [
					...receipt.contextDirectories,
				],
			});
	}
	listRepositories(): SlackEngineeringRepository[] {
		return this.deps.repositories().map((repository) => ({
			...repository,
			routingHints: [...repository.routingHints],
		}));
	}
	allReceipts(): SlackEngineeringReceipt[] {
		return Array.from(this.receipts.values()).map((receipt) => ({
			...receipt,
			targetRepositories: [...receipt.targetRepositories],
			prUrls: receipt.prUrls && [...receipt.prUrls],
			contextDirectories: receipt.contextDirectories && [
				...receipt.contextDirectories,
			],
		}));
	}
	current(parentSessionId: string): SlackEngineeringReceipt | undefined {
		return Array.from(this.receipts.values())
			.filter((receipt) => receipt.parentSessionId === parentSessionId)
			.sort((a, b) => b.kickoffTs.localeCompare(a.kickoffTs))[0];
	}
	byWorkItem(workItemId: string): SlackEngineeringReceipt | undefined {
		return Array.from(this.receipts.values()).find(
			(receipt) => receipt.workItemId === workItemId,
		);
	}
	async addContextDirectory(
		parentSessionId: string,
		directory: string,
	): Promise<void> {
		const receipt = this.requireCurrent(parentSessionId);
		receipt.contextDirectories = Array.from(
			new Set([...(receipt.contextDirectories ?? []), directory]),
		);
		await this.persist();
	}

	async createAndStart(
		source: SlackEngineeringSource,
		input: SlackEngineeringCreateInput,
	): Promise<SlackEngineeringReceipt> {
		const threadKey = this.threadKey(source);
		const currentKey = this.threadIndex.get(threadKey);
		const current = currentKey ? this.receipts.get(currentKey) : undefined;
		const sourceKey = slackEngineeringSourceKey(source);
		if (current) {
			if (source.contextDirectory) {
				current.contextDirectories = Array.from(
					new Set([
						...(current.contextDirectories ?? []),
						source.contextDirectory,
					]),
				);
				await this.persist();
			}
			if (current.sourceKey === sourceKey && current.status !== "creating")
				return current;
			if (current.sourceKey !== sourceKey && !TERMINAL.has(current.status))
				return current;
		}
		const repositories = this.deps.repositories();
		const resolve = (value: string) =>
			repositories.find(
				(repository) =>
					repository.name.toLowerCase() === value.toLowerCase() ||
					repository.fullName.toLowerCase() === value.toLowerCase(),
			);
		const primary = resolve(input.issueRepository);
		if (!primary)
			throw new Error(
				`${input.issueRepository} is not an active configured GitHub repository`,
			);
		const requested = input.targetRepositories?.length
			? input.targetRepositories
			: [primary.fullName];
		const targets = requested.map((value) => {
			const repository = resolve(value);
			if (!repository)
				throw new Error(
					`${value} is not an active configured GitHub repository`,
				);
			return repository.fullName;
		});
		if (
			!targets.some(
				(value) => value.toLowerCase() === primary.fullName.toLowerCase(),
			)
		)
			throw new Error(
				"targetRepositories must contain the primary issue repository",
			);
		let receipt = this.receipts.get(sourceKey);
		const recoveringCreatingReceipt = Boolean(receipt);
		if (!receipt) {
			receipt = {
				...source,
				sourceKey,
				marker: `<!-- cyrus-slack-source:${sourceKey} -->`,
				status: "creating",
				issueRepository: primary.fullName,
				title: input.title,
				summary: input.summary,
				targetRepositories: Array.from(new Set(targets)),
				contextDirectories: source.contextDirectory
					? [source.contextDirectory]
					: [],
			};
			this.index(receipt);
			await this.persist();
		}
		let issue =
			receipt.issueNumber && receipt.issueUrl
				? { number: receipt.issueNumber, url: receipt.issueUrl }
				: undefined;
		if (!issue && recoveringCreatingReceipt) {
			for (const delayMs of [0, 250, 1_000]) {
				if (delayMs > 0)
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				issue = await this.deps.findIssueByMarker(
					receipt.issueRepository,
					receipt.marker,
				);
				if (issue) break;
			}
		}
		if (!issue)
			issue = await this.deps.createIssue({
				repository: receipt.issueRepository,
				title: receipt.title,
				body: `${receipt.summary}\n\nRepositories:\n${receipt.targetRepositories.map((repository) => `- ${repository}`).join("\n")}\n\nSlack thread: ${receipt.permalink}\n\n${receipt.marker}`,
				marker: receipt.marker,
			});
		receipt.issueNumber = issue.number;
		receipt.issueUrl = issue.url;
		receipt.workItemId = `slack-${receipt.sourceKey}`;
		receipt.status = "starting";
		await this.persist();
		const started = await this.deps.startWorkItem({
			workItemId: receipt.workItemId,
			repositoryFullName: receipt.issueRepository,
			issueNumber: receipt.issueNumber,
			targetRepositoryFullNames: receipt.targetRepositories,
			runnerType: "claude",
			requestId: receipt.sourceKey,
		});
		receipt.workItemId = started.workItemId ?? receipt.workItemId;
		receipt.sessionId = started.sessionId;
		receipt.status = started.status;
		await this.persist();
		return receipt;
	}
	async setStatus(
		workItemId: string,
		status: SlackEngineeringStatus,
		update: { prUrls?: string[]; error?: string } = {},
	): Promise<void> {
		const receipt = Array.from(this.receipts.values()).find(
			(item) => item.workItemId === workItemId,
		);
		if (!receipt) return;
		receipt.status = status;
		if (update.prUrls) receipt.prUrls = [...update.prUrls];
		if (update.error) receipt.error = update.error;
		await this.persist();
	}
	async prompt(
		parentSessionId: string,
		message: string,
	): Promise<SlackEngineeringReceipt> {
		const receipt = this.requireCurrent(parentSessionId);
		if (
			!receipt.workItemId ||
			(receipt.status !== "starting" && receipt.status !== "in_progress")
		)
			throw new Error("No active engineering job exists for this Slack thread");
		await this.deps.promptWorkItem(receipt.workItemId, message);
		return receipt;
	}
	async stop(parentSessionId: string): Promise<SlackEngineeringReceipt> {
		const receipt = this.requireCurrent(parentSessionId);
		if (receipt.workItemId) await this.deps.stopWorkItem(receipt.workItemId);
		receipt.status = "stopped";
		await this.persist();
		return receipt;
	}
	private requireCurrent(parentSessionId: string): SlackEngineeringReceipt {
		const receipt = this.current(parentSessionId);
		if (!receipt)
			throw new Error("No engineering job exists for this Slack thread");
		return receipt;
	}
	private index(receipt: SlackEngineeringReceipt): void {
		this.receipts.set(receipt.sourceKey, receipt);
		const key = this.threadKey(receipt);
		const existing = this.threadIndex.get(key);
		const previous = existing ? this.receipts.get(existing) : undefined;
		if (!previous || previous.kickoffTs <= receipt.kickoffTs)
			this.threadIndex.set(key, receipt.sourceKey);
	}
	private threadKey(
		source: Pick<SlackEngineeringSource, "teamId" | "channelId" | "threadTs">,
	): string {
		return `${source.teamId}\0${source.channelId}\0${source.threadTs}`;
	}
	private persist(): Promise<void> {
		return this.deps.persist(this.allReceipts());
	}
}
