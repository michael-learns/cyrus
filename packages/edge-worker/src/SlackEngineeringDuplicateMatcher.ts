export interface SlackEngineeringDuplicateRequest {
	title: string;
	summary: string;
}

export interface SlackEngineeringIssueForDuplicateCheck {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	url: string;
}

export interface SlackEngineeringDuplicateCandidate {
	number: number;
	title: string;
	state: "open" | "closed";
	url: string;
	match: "exact_title" | "strong_similarity";
	score: number;
}

export interface SlackEngineeringDuplicateMatchResult {
	exactOpen?: SlackEngineeringDuplicateCandidate;
	confirmationReason?: "closed_exact" | "similar";
	confirmationCandidates: SlackEngineeringDuplicateCandidate[];
}

const MAX_CONFIRMATION_CANDIDATES = 5;
const TITLE_DICE_THRESHOLD = 0.8;
const TITLE_AND_BODY_DICE_THRESHOLD = 0.68;
const BODY_DICE_THRESHOLD = 0.55;

export function normalizeSlackEngineeringIssueText(text: string): string {
	return text
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function findSlackEngineeringDuplicates(
	request: SlackEngineeringDuplicateRequest,
	issues: readonly SlackEngineeringIssueForDuplicateCheck[],
): SlackEngineeringDuplicateMatchResult {
	const normalizedTitle = normalizeSlackEngineeringIssueText(request.title);
	const titleTokens = tokenize(normalizedTitle);
	const summaryTokens = tokenize(
		normalizeSlackEngineeringIssueText(request.summary),
	);
	const exactCandidates: SlackEngineeringDuplicateCandidate[] = [];
	const similarCandidates: SlackEngineeringDuplicateCandidate[] = [];

	for (const issue of issues) {
		const issueTitle = normalizeSlackEngineeringIssueText(issue.title);
		if (issueTitle === normalizedTitle) {
			exactCandidates.push(toCandidate(issue, "exact_title", 1));
			continue;
		}

		const issueTitleTokens = tokenize(issueTitle);
		const sharedTitleTokens = sharedTokenCount(titleTokens, issueTitleTokens);
		const titleDice = dice(titleTokens, issueTitleTokens, sharedTitleTokens);
		const bodyDice = dice(
			summaryTokens,
			tokenize(normalizeSlackEngineeringIssueText(issue.body)),
		);
		const isStrongSimilarity =
			sharedTitleTokens >= 2 &&
			(titleDice >= TITLE_DICE_THRESHOLD ||
				(titleDice >= TITLE_AND_BODY_DICE_THRESHOLD &&
					bodyDice >= BODY_DICE_THRESHOLD));

		if (isStrongSimilarity) {
			similarCandidates.push(
				toCandidate(
					issue,
					"strong_similarity",
					roundScore(0.8 * titleDice + 0.2 * bodyDice),
				),
			);
		}
	}

	const sortedExactCandidates = [...exactCandidates].sort(compareCandidates);
	const exactOpen = sortedExactCandidates.find(({ state }) => state === "open");
	if (exactOpen) {
		return { exactOpen, confirmationCandidates: [] };
	}

	const confirmationCandidates = [
		...sortedExactCandidates,
		...similarCandidates.sort(compareCandidates),
	].slice(0, MAX_CONFIRMATION_CANDIDATES);
	if (confirmationCandidates.length === 0) {
		return { confirmationCandidates };
	}

	return {
		confirmationReason:
			sortedExactCandidates.length > 0 ? "closed_exact" : "similar",
		confirmationCandidates,
	};
}

function tokenize(text: string): Set<string> {
	return new Set(text ? text.split(" ") : []);
}

function sharedTokenCount(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
): number {
	let shared = 0;
	for (const token of left) {
		if (right.has(token)) shared += 1;
	}
	return shared;
}

function dice(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
	shared = sharedTokenCount(left, right),
): number {
	return left.size + right.size === 0
		? 0
		: (2 * shared) / (left.size + right.size);
}

function toCandidate(
	issue: SlackEngineeringIssueForDuplicateCheck,
	match: SlackEngineeringDuplicateCandidate["match"],
	score: number,
): SlackEngineeringDuplicateCandidate {
	return {
		number: issue.number,
		title: issue.title,
		state: issue.state,
		url: issue.url,
		match,
		score,
	};
}

function compareCandidates(
	left: SlackEngineeringDuplicateCandidate,
	right: SlackEngineeringDuplicateCandidate,
): number {
	if (left.match !== right.match) {
		return left.match === "exact_title" ? -1 : 1;
	}
	if (left.match === "strong_similarity" && left.score !== right.score) {
		return right.score - left.score;
	}
	if (left.state !== right.state) {
		return left.state === "open" ? -1 : 1;
	}
	return right.number - left.number;
}

function roundScore(score: number): number {
	return Math.round(score * 1_000) / 1_000;
}
