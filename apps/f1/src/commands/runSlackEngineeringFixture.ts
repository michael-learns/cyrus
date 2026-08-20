import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { error, gray, success } from "../utils/colors.js";

export function createRunSlackEngineeringFixtureCommand(): Command {
	return new Command("run-slack-engineering-fixture")
		.description(
			"Run one synthetic Slack engineering action through production capture and orchestration",
		)
		.requiredOption(
			"-f, --fixture <path>",
			"JSON fixture describing the action",
		)
		.action(async (options: { fixture: string }) => {
			const port = process.env.CYRUS_PORT || "3600";
			const url = `http://localhost:${port}/cli/slack-engineering`;
			console.error(gray(`POST ${url}`));
			try {
				const body = JSON.parse(
					await readFile(options.fixture, "utf8"),
				) as unknown;
				const response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const payload = (await response.json()) as {
					ok?: boolean;
					error?: string;
				};
				if (!response.ok || !payload.ok) {
					throw new Error(payload.error ?? `HTTP ${response.status}`);
				}
				console.error(success("Synthetic Slack engineering action completed"));
				console.log(JSON.stringify(payload, null, 2));
			} catch (caught) {
				console.error(
					error(
						`Failed to run Slack engineering fixture: ${caught instanceof Error ? caught.message : String(caught)}`,
					),
				);
				process.exitCode = 1;
			}
		});
}
