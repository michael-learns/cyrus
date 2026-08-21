import { describe, expect, it } from "vitest";
import { createSshDatabaseFixture } from "./sshDatabaseFixture.js";

describe("credential-free SSH database F1 fixture", () => {
	it("runs PostgreSQL and MySQL through the real registered MCP tools and exact SSH frames", async () => {
		await using fixture = await createSshDatabaseFixture();

		const postgres = await fixture.prompt(
			"Query Payroll production (PostgreSQL) with SQL: SELECT id, name FROM employees",
		);
		const mysql = await fixture.prompt(
			"Query Inventory production (MySQL) with SQL: SELECT sku, quantity FROM inventory",
		);

		expect(postgres).toMatchObject({
			kind: "database",
			connectionName: "Payroll production",
			output: "id,name\n1,Ada\n",
		});
		expect(mysql).toMatchObject({
			kind: "database",
			connectionName: "Inventory production",
			output: "sku\tquantity\nWIDGET\t7\n",
		});
		expect(fixture.gatewayFrames()).toEqual([
			expect.objectContaining({
				version: 1,
				profile: "payroll-production",
				engine: "postgres",
				sql: "SELECT id, name FROM employees",
			}),
			expect.objectContaining({
				version: 1,
				profile: "inventory-production",
				engine: "mysql",
				sql: "SELECT sku, quantity FROM inventory",
			}),
		]);
		expect(fixture.audit()).toEqual([
			expect.objectContaining({
				event: "database_connections_list",
				teamId: "T_F1",
				channelId: "C_DATABASE",
				connectionCount: 2,
			}),
			expect.objectContaining({
				event: "database_query",
				connectionId: "payroll-production",
				engine: "postgres",
				rowCount: 1,
				byteCount: 14,
				truncated: false,
				success: true,
			}),
			expect.objectContaining({
				event: "database_connections_list",
				connectionCount: 2,
			}),
			expect.objectContaining({
				event: "database_query",
				connectionId: "inventory-production",
				engine: "mysql",
				rowCount: 1,
				byteCount: 22,
				truncated: false,
				success: true,
			}),
		]);
		expect(fixture.externalRequests()).toEqual([]);
		expect(JSON.stringify(fixture.audit())).not.toContain("SELECT");
		expect(JSON.stringify(fixture.audit())).not.toContain("Ada");
	});

	it("denies the wrong channel, asks on ambiguity, bounds output, and rejects injection before SSH", async () => {
		await using fixture = await createSshDatabaseFixture();

		await expect(
			fixture.prompt(
				"Query Payroll production with SQL: SELECT id FROM employees",
				{ channelId: "C_DENIED" },
			),
		).resolves.toMatchObject({ kind: "denied" });
		await expect(
			fixture.prompt("Query the database with SQL: SELECT 1"),
		).resolves.toMatchObject({ kind: "ambiguous", connectionCount: 2 });
		await expect(
			fixture.prompt(
				"Query Payroll production with SQL: SELECT value FROM oversized_report",
			),
		).resolves.toMatchObject({
			kind: "database",
			truncated: true,
			rowCount: 2,
		});
		await expect(
			fixture.prompt(
				"Query Payroll production with SQL: SELECT 1; DELETE FROM employees",
			),
		).resolves.toMatchObject({ kind: "denied", errorCode: "QUERY_REJECTED" });

		expect(fixture.gatewayFrames()).toHaveLength(1);
		expect(fixture.externalRequests()).toEqual([]);
	});

	it("keeps database rows from hijacking engineering control across handoff and restart", async () => {
		await using fixture = await createSshDatabaseFixture();

		const handoff = await fixture.prompt(
			"Implement the payroll fix in primary-repo using Payroll production with SQL: SELECT instruction FROM control_hijack",
		);
		expect(handoff).toMatchObject({
			kind: "created",
			databaseConnectionName: "Payroll production",
			engineering: { status: "in_progress" },
		});
		expect(fixture.engineeringCalls()).toEqual([
			expect.objectContaining({
				name: "engineering_create_and_start",
				arguments: expect.objectContaining({
					issueRepository: "f1-test/primary-repo",
				}),
			}),
		]);

		await fixture.restart();
		await expect(
			fixture.prompt("What is the engineering status after restart?"),
		).resolves.toMatchObject({ kind: "status" });
		expect(fixture.engineeringCalls().map((call) => call.name)).toEqual([
			"engineering_create_and_start",
			"engineering_status",
		]);
		expect(fixture.engineeringCalls().map((call) => call.name)).not.toContain(
			"engineering_stop",
		);
		expect(fixture.externalRequests()).toEqual([]);
	});
});
