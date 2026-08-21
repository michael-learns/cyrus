import { describe, expect, it } from "vitest";
import { DatabaseAuthorizationContextService } from "../src/DatabaseAuthorizationContextService.js";

describe("DatabaseAuthorizationContextService", () => {
	it("issues immutable Slack chat and engineering records", () => {
		const service = new DatabaseAuthorizationContextService();
		const chat = service.issue("cap-chat", {
			platform: "slack",
			teamId: "T1",
			channelId: "C1",
			userId: "U1",
			parentSessionId: "slack-session-1",
			repositoryIds: ["payroll"],
		});
		const engineering = service.issue("cap-engineering", {
			platform: "slack-engineering",
			teamId: "T1",
			channelId: "C1",
			userId: "U1",
			parentSessionId: "slack-session-1",
			workItemId: "work-item-1",
			repositoryIds: ["payroll", "shared"],
		});

		expect(chat).toMatchObject({ capabilityId: "cap-chat", platform: "slack" });
		expect(engineering).toMatchObject({
			capabilityId: "cap-engineering",
			platform: "slack-engineering",
			workItemId: "work-item-1",
		});
		expect(Object.isFrozen(chat)).toBe(true);
		expect(Object.isFrozen(chat.repositoryIds)).toBe(true);
		expect(() => (chat.repositoryIds as string[]).push("attacker")).toThrow();
	});

	it("fails closed for forged, stale, cross-session, and malformed contexts", () => {
		let now = 10;
		const service = new DatabaseAuthorizationContextService({
			now: () => now,
			ttlMs: 100,
		});
		service.issue("cap-1", {
			platform: "slack",
			teamId: "T1",
			channelId: "C1",
			userId: "U1",
			parentSessionId: "session-1",
			repositoryIds: ["payroll"],
		});

		expect(service.get("forged", "session-1")).toBeUndefined();
		expect(service.get("cap-1", "different-session")).toBeUndefined();
		expect(service.get("cap-1", "session-1")).toBeDefined();
		now = 111;
		expect(service.get("cap-1", "session-1")).toBeUndefined();
		expect(() =>
			service.issue("cap-invalid", {
				platform: "github" as "slack",
				teamId: "T1",
				channelId: "C1",
				userId: "U1",
				parentSessionId: "session-1",
				repositoryIds: ["payroll"],
			}),
		).toThrow();
		expect(() =>
			service.issue("cap-invalid-2", {
				platform: "slack-engineering",
				teamId: "T1",
				channelId: "C1",
				userId: "U1",
				parentSessionId: "session-1",
				repositoryIds: ["payroll"],
			} as never),
		).toThrow();
	});

	it("revokes by capability, parent session, and all contexts", () => {
		const service = new DatabaseAuthorizationContextService();
		const input = {
			platform: "slack" as const,
			teamId: "T1",
			channelId: "C1",
			userId: "U1",
			parentSessionId: "session-1",
			repositoryIds: ["payroll"],
		};
		service.issue("cap-1", input);
		service.issue("cap-2", input);
		service.issue("cap-3", { ...input, parentSessionId: "session-2" });

		expect(service.revoke("cap-1")).toBe(true);
		expect(service.revokeParentSession("session-1")).toBe(1);
		expect(service.get("cap-3", "session-2")).toBeDefined();
		service.revokeAll();
		expect(service.get("cap-3", "session-2")).toBeUndefined();
	});
});
