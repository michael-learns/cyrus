import { describe, expect, it } from "vitest";
import {
	findSlackEngineeringDuplicates,
	normalizeSlackEngineeringIssueText,
	type SlackEngineeringIssueForDuplicateCheck,
} from "../src/SlackEngineeringDuplicateMatcher.js";

const issues: SlackEngineeringIssueForDuplicateCheck[] = [
	{
		number: 8,
		title: "fix PAYROLL export!",
		body: "The export rounds overtime incorrectly.",
		state: "open",
		url: "https://github.com/acme/payroll/issues/8",
	},
];

describe("SlackEngineeringDuplicateMatcher", () => {
	it("normalizes Unicode, punctuation, casing, and whitespace before matching", () => {
		expect(normalizeSlackEngineeringIssueText("  Fix: PAYROLL—Export! ")).toBe(
			"fix payroll export",
		);
	});

	it("automatically selects an open exact normalized title without returning bodies", () => {
		expect(
			findSlackEngineeringDuplicates(
				{
					title: "Fix payroll export",
					summary: "Rounding fails for overtime.",
				},
				issues,
			),
		).toEqual({
			exactOpen: {
				number: 8,
				title: "fix PAYROLL export!",
				state: "open",
				url: "https://github.com/acme/payroll/issues/8",
				match: "exact_title",
				score: 1,
			},
			confirmationCandidates: [],
		});
	});

	it("requires confirmation for a closed exact title", () => {
		expect(
			findSlackEngineeringDuplicates(
				{
					title: "Fix payroll export",
					summary: "Rounding fails for overtime.",
				},
				[{ ...issues[0], state: "closed" }],
			),
		).toEqual({
			confirmationReason: "closed_exact",
			confirmationCandidates: [
				{
					number: 8,
					title: "fix PAYROLL export!",
					state: "closed",
					url: "https://github.com/acme/payroll/issues/8",
					match: "exact_title",
					score: 1,
				},
			],
		});
	});

	it("returns title-only and title-plus-body strong similarities", () => {
		const result = findSlackEngineeringDuplicates(
			{
				title: "Fix payroll export rounding overtime calculation",
				summary: "Overtime payroll export rounds values after tax calculation.",
			},
			[
				{
					number: 21,
					title: "Payroll export rounding calculation fix overtime",
					body: "A different implementation detail.",
					state: "open",
					url: "https://github.com/acme/payroll/issues/21",
				},
				{
					number: 22,
					title: "Fix payroll export rounding reconciliation",
					body: "Overtime payroll export rounds values after tax reconciliation.",
					state: "closed",
					url: "https://github.com/acme/payroll/issues/22",
				},
			],
		);

		expect(result).toMatchObject({ confirmationReason: "similar" });
		expect(result.confirmationCandidates).toEqual([
			expect.objectContaining({
				number: 21,
				match: "strong_similarity",
				score: 0.8,
			}),
			expect.objectContaining({
				number: 22,
				match: "strong_similarity",
				score: 0.757,
			}),
		]);
	});

	it("rejects a one-token overlap and a title-plus-body score below the threshold", () => {
		const result = findSlackEngineeringDuplicates(
			{
				title: "Fix payroll export rounding overtime calculation",
				summary: "Overtime payroll export rounds values after tax calculation.",
			},
			[
				{
					number: 30,
					title: "Fix invoice import",
					body: "Unrelated payroll terminology.",
					state: "open",
					url: "https://github.com/acme/payroll/issues/30",
				},
				{
					number: 31,
					title: "Fix payroll export rounding tax reconciliation",
					body: "Overtime payroll export rounds values after tax reconciliation.",
					state: "open",
					url: "https://github.com/acme/payroll/issues/31",
				},
			],
		);

		expect(result).toEqual({ confirmationCandidates: [] });
	});

	it("orders exact candidates first, then similar candidates by score, open state, and number", () => {
		const result = findSlackEngineeringDuplicates(
			{ title: "Fix payroll export", summary: "Payroll export failure." },
			[
				{ ...issues[0], number: 10, state: "closed" },
				{
					number: 12,
					title: "Fix payroll export failure",
					body: "Payroll export failure.",
					state: "closed",
					url: "https://github.com/acme/payroll/issues/12",
				},
				{
					number: 11,
					title: "Fix payroll export failure",
					body: "Payroll export failure.",
					state: "open",
					url: "https://github.com/acme/payroll/issues/11",
				},
				{
					number: 13,
					title: "Fix payroll export failure",
					body: "Different body.",
					state: "open",
					url: "https://github.com/acme/payroll/issues/13",
				},
			],
		);

		expect(result.confirmationCandidates.map(({ number }) => number)).toEqual([
			10, 11, 12, 13,
		]);
	});

	it("caps confirmation candidates at five and never exposes issue bodies", () => {
		const result = findSlackEngineeringDuplicates(
			{ title: "Fix payroll export", summary: "Payroll export failure." },
			Array.from({ length: 6 }, (_, index) => ({
				number: index + 1,
				title: "Fix payroll export failure",
				body: `Secret body ${index + 1}`,
				state: "open" as const,
				url: `https://github.com/acme/payroll/issues/${index + 1}`,
			})),
		);

		expect(result.confirmationCandidates).toHaveLength(5);
		expect(result.confirmationCandidates.map(({ number }) => number)).toEqual([
			6, 5, 4, 3, 2,
		]);
		expect(JSON.stringify(result)).not.toContain("Secret body");
	});
});
