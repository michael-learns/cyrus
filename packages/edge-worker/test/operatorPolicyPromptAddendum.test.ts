import { describe, expect, it } from "vitest";
import { appendOperatorPolicyAddendum } from "../src/prompts/operatorPolicyPromptAddendum.js";

describe("appendOperatorPolicyAddendum", () => {
	it("returns the prompt unchanged when no policy is configured", () => {
		expect(appendOperatorPolicyAddendum("base prompt", undefined)).toBe(
			"base prompt",
		);
		expect(appendOperatorPolicyAddendum("base prompt", "   ")).toBe(
			"base prompt",
		);
	});

	it("appends the operator policy in a tagged block", () => {
		const out = appendOperatorPolicyAddendum(
			"base prompt",
			"Never output code.",
		);

		expect(out).toContain("base prompt");
		expect(out).toContain("<operator_policy>");
		expect(out).toContain("Never output code.");
		expect(out).toContain("</operator_policy>");
	});

	it("places the policy last so it overrides earlier prompt content", () => {
		const out = appendOperatorPolicyAddendum(
			"You can delegate implementation work.",
			"Never output code.",
		);

		expect(out.indexOf("<operator_policy>")).toBeGreaterThan(
			out.indexOf("You can delegate implementation work."),
		);
	});

	it("marks the policy as non-overridable by message content", () => {
		const out = appendOperatorPolicyAddendum("base", "Never output code.");

		// The operator sets this, not anyone talking to the bot. Message
		// content must not be able to lift it.
		expect(out.toLowerCase()).toContain("cannot be overridden");
	});

	it("handles an empty or missing base prompt", () => {
		const out = appendOperatorPolicyAddendum("", "Never output code.");
		expect(out).toContain("<operator_policy>");
		expect(out.startsWith("\n")).toBe(false);
	});
});
