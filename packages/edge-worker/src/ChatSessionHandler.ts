import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SDKMessage, SdkPluginConfig } from "cyrus-claude-runner";
import type {
	AgentPendingWork,
	AgentRunnerConfig,
	AgentSessionInfo,
	CyrusAgentSession,
	IAgentRunner,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { createLogger } from "cyrus-core";
import { AgentSessionManager } from "./AgentSessionManager.js";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { RunnerConfigBuilder } from "./RunnerConfigBuilder.js";

/**
 * Defines what each chat platform must provide for the generic session lifecycle.
 *
 * Implementations are stateless data mappers — they translate platform-specific
 * events into the common operations the ChatSessionHandler needs.
 */
/** Platform identifiers supported by the session manager */
export type ChatPlatformName = "slack" | "linear" | "github";
type SDKResultMessage = Extract<SDKMessage, { type: "result" }>;

export interface ChatPlatformAdapter<TEvent> {
	readonly platformName: ChatPlatformName;

	/** Extract the user's task text from the raw event */
	extractTaskInstructions(event: TEvent): string;

	/**
	 * Whether this event is allowed to *start* a brand-new session for its
	 * thread. Events that may only continue an already-bound thread (e.g. a
	 * plain Slack message that isn't an @mention) return false, so the handler
	 * ignores them when no session exists yet.
	 *
	 * Optional — when omitted, every event is treated as session-initiating
	 * (the behaviour for platforms where every event is an explicit invocation).
	 */
	isSessionInitiatingEvent?(event: TEvent): boolean | Promise<boolean>;

	/** Derive a unique thread key for session tracking (e.g., "C123:1704110400.000100") */
	getThreadKey(event: TEvent): string;

	/** Get the unique event ID */
	getEventId(event: TEvent): string;

	/** Build a platform-specific system prompt */
	buildSystemPrompt(event: TEvent): string;

	/**
	 * Thread context as a formatted string, or "" if not applicable. Pass
	 * `sinceTs` to read only what followed it, so a resumed session catches up on
	 * discussion it never saw. `null` means the read failed — only a non-null
	 * result advances the cursor.
	 */
	fetchThreadContext(event: TEvent, sinceTs?: string): Promise<string | null>;

	/**
	 * This event's thread position, stored as the catch-up cursor. Optional —
	 * platforms that deliver every thread message omit it and get no catch-up.
	 */
	getThreadContextTs?(event: TEvent): string | undefined;

	/** Post the agent's final response back to the platform */
	postReply(
		event: TEvent,
		runner: IAgentRunner,
		resultMessage?: SDKResultMessage,
	): Promise<void>;

	/** Post a non-final status when the session has scheduled future work. */
	postPendingStatus?(
		event: TEvent,
		pendingWork: AgentPendingWork,
	): Promise<void>;

	/** Start the platform's transient activity indicator for an accepted request. */
	startActivityStatus?(event: TEvent, taskInstructions: string): Promise<void>;

	/** Update the activity indicator from a runner lifecycle message. */
	updateActivityStatus?(event: TEvent, message: SDKMessage): Promise<void>;

	/** Show that active background work still needs to finish. */
	setBackgroundActivityStatus?(event: TEvent): Promise<void>;

	/** Clear the platform's transient activity indicator. */
	/**
	 * Clear the platform's transient activity indicator. `retainState` hides the
	 * displayed status but keeps the indicator's bookkeeping alive, for a session
	 * that will wake itself again without a new inbound event.
	 */
	clearActivityStatus?(
		event: TEvent,
		options?: { retainState?: boolean },
	): Promise<void>;

	/** Acknowledge receipt of the event (e.g., emoji reaction). Fire-and-forget */
	acknowledgeReceipt(event: TEvent): Promise<void>;

	/**
	 * Acknowledge that the agent finished processing the event (e.g., swap the
	 * receipt reaction for a "done" one). Called after the turn completes,
	 * whether or not a reply was actually posted — this is what tells users a
	 * message was seen even when the agent chose to stay silent.
	 *
	 * Optional — platforms without a processed indicator omit it. Fire-and-forget.
	 */
	acknowledgeProcessed?(event: TEvent): Promise<void>;

	/** Notify the user that a previous request is still processing */
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;
}

/**
 * Callbacks for EdgeWorker integration (same pattern as RepositoryRouterDeps).
 */
export interface ChatSessionHandlerDeps {
	cyrusHome: string;
	/** Provider for live repository paths, default repo, and workspace ID */
	chatRepositoryProvider: ChatRepositoryProvider;
	/** Shared RunnerConfigBuilder for constructing runner configs */
	runnerConfigBuilder: RunnerConfigBuilder;
	/** Factory function that creates the appropriate runner based on config.defaultRunner */
	createRunner: (config: AgentRunnerConfig) => IAgentRunner;
	/**
	 * Live read of the workspace-level custom-integration MCP config paths
	 * for the chat platform this handler is bound to (e.g.
	 * `config.slackMcpConfigs` for Slack). Chat sessions are repo-agnostic,
	 * so `repository.mcpConfigPath` is not consulted; only this list
	 * determines which custom `.mcp.json` files load. When empty/omitted,
	 * no custom files load (native MCP servers still run as usual).
	 */
	getPlatformMcpConfigOverrides?: () => readonly string[] | undefined;
	/** Resolve managed skill plugins and scoped skill names for a chat session. */
	resolveSkillsConfig?: (input: {
		repository?: RepositoryConfig;
		repositoryPaths: string[];
	}) => Promise<{ plugins?: SdkPluginConfig[]; skills?: string[] | "all" }>;
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onStateChange: () => Promise<void>;
	onClaudeError: (error: Error) => void;
}

/**
 * Generic session lifecycle engine for chat platform integrations.
 *
 * Manages the create/resume/inject/reply session lifecycle independent of any
 * specific chat platform. Platform-specific behavior is provided via a
 * ChatPlatformAdapter.
 */
export class ChatSessionHandler<TEvent> {
	private adapter: ChatPlatformAdapter<TEvent>;
	private sessionManager: AgentSessionManager;
	private threadSessions: Map<string, string> = new Map();
	private deps: ChatSessionHandlerDeps;
	private logger: ILogger;
	// Queue of events awaiting a reply, keyed by sessionId. Each entry is
	// enqueued when a new prompt (initial/resume/follow-up-inject) is sent to
	// the runner, and the queue is drained when a `result` message arrives on
	// the runner's message stream. This decouples reply posting from
	// `startStreaming()` resolution, which never resolves when warm sessions
	// hold the streaming prompt open across turns.
	//
	// Drained wholesale, NOT one-per-result: messages injected in quick
	// succession get merged by the runner into a single turn (one `result`
	// answering several queued prompts), so a strict FIFO pairing would leave
	// orphaned entries that never get acknowledged — and would pair them with
	// the wrong later turns.
	private pendingReplyEvents: Map<string, TEvent[]> = new Map();
	// Last event enqueued per session. When a merged turn drained the queue
	// ahead of schedule, a subsequent `result` finds the queue empty — this
	// remembers where to post that turn's reply (all events in a session share
	// one thread, so any recent event addresses it correctly).
	private lastReplyEvent: Map<string, TEvent> = new Map();
	// Follow-up events that arrived while a turn was running and could not be
	// streamed into it (e.g. the exec Codex backend, which has no mid-turn input
	// channel). Keyed by threadKey. Drained when the running turn completes and
	// re-dispatched as a fresh turn, so a follow-up is never silently dropped —
	// honoring the "I'll pick up your new message once I'm done" promise.
	private pendingFollowups: Map<string, TEvent[]> = new Map();
	/** Last scheduled-work status posted for each session, used to avoid duplicates. */
	private pendingWorkNotificationKeys: Map<string, string> = new Map();
	/**
	 * Child engineering jobs that temporarily own this chat thread's status,
	 * keyed by chat session id. One chat session can delegate several jobs at
	 * once, so ownership is tracked per work item: releasing one job must not
	 * hand the status back while its siblings are still running.
	 */
	private delegatedWorkSessions: Map<string, Set<string>> = new Map();
	// Serializes events for a thread that is not yet bound to a session. Binding
	// spans several awaits (the adapter's session-initiation check, workspace
	// creation), and until the binding lands `threadSessions` still reads as
	// unbound — a follow-up that interleaved with those awaits would evaluate
	// that stale snapshot, be judged non-initiating, and get discarded. Chaining
	// makes each event for a thread observe the previous one's binding.
	private threadEventQueues: Map<string, Promise<void>> = new Map();

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: ChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger = logger ?? createLogger({ component: "ChatSessionHandler" });

		// Initialize a dedicated AgentSessionManager (not tied to any repository)
		this.sessionManager = new AgentSessionManager(
			undefined, // No parent session lookup
			undefined, // No resume parent session
		);
	}

	/**
	 * Main entry point — handles a single chat platform event.
	 *
	 * Replaces the per-platform handleXxxWebhook method in EdgeWorker.
	 *
	 * Events for the same thread run one at a time, so a message that arrives
	 * while an earlier one is still establishing the thread → session binding
	 * sees that binding instead of a stale "unbound" snapshot.
	 */
	async handleEvent(event: TEvent): Promise<void> {
		const threadKey = this.adapter.getThreadKey(event);
		// Once a thread is bound to a session, events may run concurrently — the
		// catch-up cursor has its own monotonicity guard for that. Only the
		// unbound window needs serializing, because binding spans several awaits
		// and a follow-up landing inside it would read a stale "unbound" snapshot.
		if (this.threadSessions.has(threadKey)) {
			return this.processEvent(event);
		}
		const previous = this.threadEventQueues.get(threadKey) ?? Promise.resolve();
		const next = previous.then(() => this.processEvent(event));
		// Store an error-swallowing view of the chain so one failure never blocks
		// later events for the thread (processEvent logs its own errors), and drop
		// the entry once the thread goes idle again.
		const chained: Promise<void> = next
			.catch(() => undefined)
			.then(() => {
				if (this.threadEventQueues.get(threadKey) === chained) {
					this.threadEventQueues.delete(threadKey);
				}
			});
		this.threadEventQueues.set(threadKey, chained);
		return next;
	}

	/**
	 * Processes a single event. Invoked only through the per-thread queue in
	 * handleEvent, so at most one event per thread is ever in flight.
	 */
	private async processEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();

		try {
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${this.adapter.getEventId(event)}`,
			);

			// Fire-and-forget acknowledgement (e.g., emoji reaction)
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			const taskInstructions = this.adapter.extractTaskInstructions(event);
			const threadKey = this.adapter.getThreadKey(event);

			// Check if there's already an active session for this thread
			const existingSessionId = this.threadSessions.get(threadKey);
			if (existingSessionId) {
				const existingSession =
					this.sessionManager.getSession(existingSessionId);
				const existingRunner =
					this.sessionManager.getAgentRunner(existingSessionId);

				if (existingSession && existingRunner?.isRunning()) {
					// Session is actively running — inject the follow-up via streaming input
					if (
						existingRunner.addStreamMessage &&
						existingRunner.isStreaming?.()
					) {
						await this.startActivityStatus(event, taskInstructions);
						this.logger.info(
							`Injecting follow-up prompt into running session ${existingSessionId} (thread ${threadKey})`,
						);
						this.enqueueReply(existingSessionId, event);
						existingRunner.addStreamMessage(
							await this.withThreadCatchup(
								existingSession,
								event,
								taskInstructions,
							),
						);
					} else {
						// Runner can't accept mid-turn input (e.g. exec Codex). Queue the
						// follow-up so it's delivered as a fresh turn once this one ends,
						// rather than dropped — then tell the user we'll pick it up.
						this.logger.info(
							`Session ${existingSessionId} is still running; queuing follow-up for after the turn (thread ${threadKey})`,
						);
						this.queuePendingFollowup(threadKey, event);
						await this.adapter.notifyBusy(event, threadKey);
						void this.setBackgroundActivityStatus(event);
					}
					return;
				}

				if (existingSession && existingRunner) {
					// Session exists but is not running — resume with --continue
					this.logger.info(
						`Resuming completed ${this.adapter.platformName} session ${existingSessionId} (thread ${threadKey})`,
					);

					const resumeSessionId =
						existingSession.claudeSessionId ||
						existingSession.geminiSessionId ||
						existingSession.codexSessionId ||
						existingSession.cursorSessionId;

					if (resumeSessionId) {
						await this.startActivityStatus(event, taskInstructions);
						try {
							await this.resumeSession(
								event,
								existingSession,
								existingSessionId,
								resumeSessionId,
								taskInstructions,
							);
						} catch (error) {
							await this.clearActivityStatus(event);
							this.logger.error(
								`Failed to resume ${this.adapter.platformName} session ${existingSessionId}`,
								error instanceof Error ? error : new Error(String(error)),
							);
						}
						return;
					}
				}

				// Session exists but runner was lost — fall through to create a new session
				this.logger.info(
					`Previous session ${existingSessionId} for thread ${threadKey} has no runner, creating new session`,
				);
			}

			// No session exists for this thread. Only events explicitly allowed to
			// start a session may do so — e.g. a Slack @mention. A plain follow-up
			// message in an unbound thread must be ignored, otherwise every message
			// in any channel Cyrus can see would spin up a session.
			const mayInitiateSession =
				!existingSessionId && this.adapter.isSessionInitiatingEvent
					? await this.adapter.isSessionInitiatingEvent(event)
					: true;
			if (!existingSessionId && !mayInitiateSession) {
				this.logger.info(
					`Ignoring non-initiating ${this.adapter.platformName} event for unbound thread ${threadKey}`,
				);
				return;
			}

			await this.startActivityStatus(event, taskInstructions);

			// Create an empty workspace directory for this thread
			const workspace = await this.createWorkspace(threadKey);
			if (!workspace) {
				await this.clearActivityStatus(event);
				this.logger.error(
					`Failed to create workspace for ${this.adapter.platformName} thread ${threadKey}`,
				);
				return;
			}

			this.logger.info(
				`${this.adapter.platformName} workspace created at: ${workspace.path}`,
			);

			// Create a chat session (not tied to any issue or repository)
			const eventId = this.adapter.getEventId(event);
			const sessionId = `${this.adapter.platformName}-${eventId}`;
			this.sessionManager.createChatSession(
				sessionId,
				workspace,
				this.adapter.platformName,
			);

			const session = this.sessionManager.getSession(sessionId);
			if (!session) {
				await this.clearActivityStatus(event);
				this.logger.error(
					`Failed to create session for ${this.adapter.platformName} webhook ${eventId}`,
				);
				return;
			}

			// Track this thread → session mapping for follow-up messages
			this.threadSessions.set(threadKey, sessionId);

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Build the system prompt
			const systemPrompt = this.adapter.buildSystemPrompt(event);

			// Build runner config
			const runnerConfig = await this.buildRunnerConfig(
				session.workspace.path,
				sessionId,
				systemPrompt,
				sessionId,
			);

			const runner = this.deps.createRunner(runnerConfig);

			// Store the runner in the session manager
			this.sessionManager.addAgentRunner(sessionId, runner);

			// Save persisted state
			await this.deps.onStateChange();

			// Fetch thread context for threaded mentions
			const userPrompt = await this.withThreadContext(
				session,
				event,
				taskInstructions,
			);

			this.logger.info(
				`Starting runner for ${this.adapter.platformName} event ${eventId}`,
			);

			// Start in streaming mode if supported (allows follow-up message injection),
			// otherwise fall back to non-streaming start.
			//
			// Reply posting happens from handleAgentMessage() when a `result`
			// message arrives on the runner's stream — we do NOT await turn
			// completion here, because with warm sessions the streaming prompt
			// stays open and the start() promise doesn't resolve until the
			// whole session ends.
			this.enqueueReply(sessionId, event);
			const startPromise =
				runner.supportsStreamingInput && runner.startStreaming
					? runner.startStreaming(userPrompt)
					: runner.start(userPrompt);
			startPromise
				.then((sessionInfo: AgentSessionInfo) => {
					this.logger.info(
						`${this.adapter.platformName} session started: ${sessionInfo.sessionId}`,
					);
				})
				.catch((error: unknown) => {
					this.logger.error(
						`${this.adapter.platformName} session error for event ${eventId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
					// Runner died before emitting a final `result`. Drop any
					// still-queued reply events for this session so a later
					// resumeSession() doesn't pair them with a future turn.
					void this.clearActivityStatus(event);
					this.clearPendingReplies(sessionId);
				})
				.finally(() => {
					this.deps.onStateChange().catch((error: unknown) => {
						this.logger.error(
							`onStateChange failed after ${this.adapter.platformName} session ${sessionId}`,
							error instanceof Error ? error : new Error(String(error)),
						);
					});
				});
		} catch (error) {
			await this.clearActivityStatus(event);
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	/** Returns true if any runner managed by this handler is currently busy */
	isAnyRunnerBusy(): boolean {
		for (const runner of this.sessionManager.getAllAgentRunners()) {
			if (runner.isRunning()) {
				return true;
			}
		}
		return false;
	}

	/** Returns all runners managed by this handler (for shutdown) */
	getAllRunners(): IAgentRunner[] {
		return this.sessionManager.getAllAgentRunners();
	}

	/**
	 * Expose every active chat session this handler owns, so EdgeWorker
	 * can resolve a cwd → session bundle from outside (e.g. the
	 * `log_failure_mode` MCP tool needs to find a Slack/GitHub chat
	 * session's runner session id). Chat sessions live in this handler's
	 * dedicated AgentSessionManager — they aren't reachable from
	 * EdgeWorker's primary AgentSessionManager.
	 */
	getAllChatSessions(): CyrusAgentSession[] {
		return this.sessionManager.getAllSessions();
	}

	/**
	 * Test/inspection: list all known thread keys and their session IDs.
	 * Used by F1 to discover chat sessions for follow-up prompts and replay.
	 */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, sessionId]) => ({ threadKey, sessionId }),
		);
	}

	/**
	 * Test/inspection: resolve a chat thread to its runner. Returns undefined
	 * when the thread is unknown or the runner has been disposed.
	 */
	getRunnerForThread(threadKey: string): IAgentRunner | undefined {
		const sessionId = this.threadSessions.get(threadKey);
		if (!sessionId) return undefined;
		return this.sessionManager.getAgentRunner(sessionId);
	}

	/** Resolve the latest platform event for a chat session without exposing it to the model. */
	getLatestEventForSession(sessionId: string): TEvent | undefined {
		return (
			this.pendingReplyEvents.get(sessionId)?.at(-1) ??
			this.lastReplyEvent.get(sessionId)
		);
	}

	/** Keep the chat status alive while a delegated child session is running. */
	setDelegatedWorkActive(
		sessionId: string,
		active: boolean,
		workItemId: string,
	): void {
		const workItemIds = this.delegatedWorkSessions.get(sessionId);
		if (active) {
			if (workItemIds) workItemIds.add(workItemId);
			else this.delegatedWorkSessions.set(sessionId, new Set([workItemId]));
			return;
		}
		if (!workItemIds) return;
		workItemIds.delete(workItemId);
		if (workItemIds.size === 0) this.delegatedWorkSessions.delete(sessionId);
	}

	/** True while at least one delegated job still owns this thread's status. */
	hasDelegatedWork(sessionId: string): boolean {
		return (this.delegatedWorkSessions.get(sessionId)?.size ?? 0) > 0;
	}

	/** Mark how far this session has thread context, for the next catch-up */
	private recordThreadContextTs(
		session: CyrusAgentSession,
		event: TEvent,
	): void {
		const ts = this.adapter.getThreadContextTs?.(event);
		if (!ts) {
			return;
		}
		if (!session.metadata) {
			session.metadata = {};
		}
		// Concurrent mentions race here; a backwards cursor re-delivers a message.
		// Slack ts is zero-padded, so string ordering is chronological.
		const current = session.metadata.lastContextTs;
		if (current && ts <= current) {
			return;
		}
		session.metadata.lastContextTs = ts;
	}

	/**
	 * Prefix the task instructions with thread context — the whole thread for a
	 * new session, or just what was said since the cursor for a follow-up. The
	 * cursor only advances on a successful read, so a failed one retries the same
	 * window instead of losing it.
	 */
	private async withThreadContext(
		session: CyrusAgentSession,
		event: TEvent,
		taskInstructions: string,
	): Promise<string> {
		let context: string | null;
		try {
			context = await this.adapter.fetchThreadContext(
				event,
				session.metadata?.lastContextTs,
			);
		} catch (error) {
			// A context read must never cost the user their message
			this.logger.warn(
				`Failed to fetch thread context for ${this.adapter.platformName} session: ${error instanceof Error ? error.message : String(error)}`,
			);
			return taskInstructions;
		}

		if (context !== null) {
			this.recordThreadContextTs(session, event);
		}

		return context ? `${context}\n\n${taskInstructions}` : taskInstructions;
	}

	/**
	 * Follow-up variant. Platforms with no thread cursor deliver every message
	 * already, so re-reading the thread would only duplicate what the session has.
	 */
	private async withThreadCatchup(
		session: CyrusAgentSession,
		event: TEvent,
		taskInstructions: string,
	): Promise<string> {
		if (!this.adapter.getThreadContextTs) {
			return taskInstructions;
		}
		return this.withThreadContext(session, event, taskInstructions);
	}

	/**
	 * Resume an existing session with a new prompt (--continue behavior).
	 */
	private async resumeSession(
		event: TEvent,
		existingSession: CyrusAgentSession,
		sessionId: string,
		resumeSessionId: string,
		taskInstructions: string,
	): Promise<void> {
		const systemPrompt = this.adapter.buildSystemPrompt(event);

		const runnerConfig = await this.buildRunnerConfig(
			existingSession.workspace.path,
			sessionId,
			systemPrompt,
			sessionId,
			resumeSessionId,
		);

		const runner = this.deps.createRunner(runnerConfig);
		this.sessionManager.addAgentRunner(sessionId, runner);

		const resumePrompt = await this.withThreadCatchup(
			existingSession,
			event,
			taskInstructions,
		);

		// Reply posting is driven by `result` messages on the runner's stream
		// (see handleAgentMessage). We must not await turn completion here —
		// warm sessions hold the streaming prompt open across turns so the
		// start() promise only resolves when the whole session ends.
		this.enqueueReply(sessionId, event);
		const startPromise =
			runner.supportsStreamingInput && runner.startStreaming
				? runner.startStreaming(resumePrompt)
				: runner.start(resumePrompt);
		startPromise
			.then((sessionInfo: AgentSessionInfo) => {
				this.logger.info(
					`${this.adapter.platformName} session resumed: ${sessionInfo.sessionId} (was ${resumeSessionId})`,
				);
			})
			.catch((error: unknown) => {
				this.logger.error(
					`${this.adapter.platformName} resume session error for ${sessionId}`,
					error instanceof Error ? error : new Error(String(error)),
				);
				void this.clearActivityStatus(event);
				this.clearPendingReplies(sessionId);
			});
	}

	/**
	 * Handle agent messages for chat sessions.
	 * Routes to the dedicated AgentSessionManager, and posts a reply when the
	 * SDK emits a `result` message (signalling turn completion).
	 */
	private async handleAgentMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		await this.sessionManager.handleClaudeMessage(sessionId, message);

		const statusEvent =
			this.pendingReplyEvents.get(sessionId)?.[0] ??
			this.lastReplyEvent.get(sessionId);
		if (statusEvent && message.type !== "result") {
			void this.updateActivityStatus(statusEvent, message);
		}

		if (message.type === "result") {
			const runner = this.sessionManager.getAgentRunner(sessionId);
			const pendingWork =
				message.subtype === "success" && !message.is_error
					? runner?.getPendingWork?.()
					: undefined;
			const hasPendingWork = Boolean(
				pendingWork &&
					(pendingWork.sessionCrons.length > 0 ||
						pendingWork.backgroundTasks.length > 0),
			);

			if (hasPendingWork && pendingWork) {
				const replyEvent =
					this.pendingReplyEvents.get(sessionId)?.[0] ??
					this.lastReplyEvent.get(sessionId);
				if (
					replyEvent &&
					pendingWork.sessionCrons.length > 0 &&
					this.adapter.postPendingStatus
				) {
					const notificationKey = JSON.stringify(
						pendingWork.sessionCrons.map((cron) => ({
							id: cron.id,
							schedule: cron.schedule,
							recurring: cron.recurring,
							prompt: cron.prompt,
						})),
					);
					const previousNotificationKey =
						this.pendingWorkNotificationKeys.get(sessionId);
					if (previousNotificationKey !== notificationKey) {
						// Reserve the key BEFORE awaiting the platform call. `result`
						// messages are emitted synchronously by the runner and handled on
						// floating promises, so a second result (a recurring wakeup firing
						// again, or a streamed turn completing) can reach this check while
						// the first post is still in flight and duplicate the waiting notice.
						this.pendingWorkNotificationKeys.set(sessionId, notificationKey);
						try {
							await this.adapter.postPendingStatus(replyEvent, pendingWork);
						} catch (error) {
							// Release the reservation so a later turn retries — unless a newer
							// turn already claimed or cleared the key in the meantime.
							if (
								this.pendingWorkNotificationKeys.get(sessionId) ===
								notificationKey
							) {
								if (previousNotificationKey === undefined) {
									this.pendingWorkNotificationKeys.delete(sessionId);
								} else {
									this.pendingWorkNotificationKeys.set(
										sessionId,
										previousNotificationKey,
									);
								}
							}
							this.logger.error(
								`Failed to post pending ${this.adapter.platformName} status for session ${sessionId}`,
								error instanceof Error ? error : new Error(String(error)),
							);
						}
					}
				} else if (pendingWork.sessionCrons.length === 0) {
					this.pendingWorkNotificationKeys.delete(sessionId);
				}

				if (replyEvent) {
					if (pendingWork.backgroundTasks.length > 0) {
						void this.setBackgroundActivityStatus(replyEvent);
					} else {
						// Only scheduled wakeups remain: the runner stays open and
						// resumes without another inbound event, so hide the status
						// while it waits but keep the indicator's state so the woken
						// turn can show progress again.
						await this.clearActivityStatus(replyEvent, {
							retainState: true,
						});
					}
				}

				this.logger.info(
					`Deferring ${this.adapter.platformName} reply for session ${sessionId}: ${pendingWork.sessionCrons.length} scheduled wakeup(s), ${pendingWork.backgroundTasks.length} background task(s) remain`,
				);
				return;
			}

			this.pendingWorkNotificationKeys.delete(sessionId);
			// A `result` ends the turn, and the turn has seen every prompt
			// injected so far — drain the whole queue, not just one entry
			// (quick-succession messages get merged into a single turn).
			const events = this.drainReplies(sessionId);
			// Queue already drained by an earlier merged turn? The reply still
			// belongs to this session's thread — post it via the last event.
			const replyEvent = events[0] ?? this.lastReplyEvent.get(sessionId);
			if (replyEvent && runner) {
				try {
					await this.adapter.postReply(replyEvent, runner, message);
				} catch (error) {
					this.logger.error(
						`Failed to post ${this.adapter.platformName} reply for session ${sessionId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
				} finally {
					if (!this.hasDelegatedWork(sessionId)) {
						await this.clearActivityStatus(replyEvent);
					}
				}
				// Fire-and-forget processed acknowledgement for every drained
				// event (e.g., swap the receipt reaction) — runs even when
				// postReply stayed silent.
				for (const event of events) {
					this.adapter.acknowledgeProcessed?.(event).catch((err: unknown) => {
						this.logger.warn(
							`Failed to acknowledge processed ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
						);
					});
				}
			} else if (!replyEvent) {
				this.logger.warn(
					`Received result for session ${sessionId} with no pending reply event — nothing to post`,
				);
			} else {
				await this.clearActivityStatus(replyEvent);
			}

			// The turn is done — deliver any follow-ups that arrived while busy.
			this.drainPendingFollowups(sessionId);
		}
	}

	private async startActivityStatus(
		event: TEvent,
		taskInstructions: string,
	): Promise<void> {
		if (!this.adapter.startActivityStatus) return;
		try {
			await this.adapter.startActivityStatus(event, taskInstructions);
		} catch (error) {
			this.logger.warn(
				`Failed to start ${this.adapter.platformName} activity status: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async updateActivityStatus(
		event: TEvent,
		message: SDKMessage,
	): Promise<void> {
		if (!this.adapter.updateActivityStatus) return;
		try {
			await this.adapter.updateActivityStatus(event, message);
		} catch (error) {
			this.logger.warn(
				`Failed to update ${this.adapter.platformName} activity status: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async setBackgroundActivityStatus(event: TEvent): Promise<void> {
		if (!this.adapter.setBackgroundActivityStatus) return;
		try {
			await this.adapter.setBackgroundActivityStatus(event);
		} catch (error) {
			this.logger.warn(
				`Failed to update ${this.adapter.platformName} background activity status: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async clearActivityStatus(
		event: TEvent,
		options?: { retainState?: boolean },
	): Promise<void> {
		if (!this.adapter.clearActivityStatus) return;
		try {
			// Forward the options object only when one was given, so the ordinary
			// clear stays a single-argument call for adapters and callers alike.
			await (options
				? this.adapter.clearActivityStatus(event, options)
				: this.adapter.clearActivityStatus(event));
		} catch (error) {
			this.logger.warn(
				`Failed to clear ${this.adapter.platformName} activity status: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private queuePendingFollowup(threadKey: string, event: TEvent): void {
		const queue = this.pendingFollowups.get(threadKey) ?? [];
		queue.push(event);
		this.pendingFollowups.set(threadKey, queue);
	}

	private threadKeyForSession(sessionId: string): string | undefined {
		for (const [threadKey, id] of this.threadSessions) {
			if (id === sessionId) {
				return threadKey;
			}
		}
		return undefined;
	}

	/**
	 * Re-dispatch any follow-ups queued for a thread while it was busy. Runs
	 * after the current turn settles (the runner has finalized), so each
	 * re-dispatched event takes the normal resume path. Any that still find the
	 * runner running re-queue themselves and are drained on the next completion.
	 */
	private drainPendingFollowups(sessionId: string): void {
		const threadKey = this.threadKeyForSession(sessionId);
		if (!threadKey) {
			return;
		}
		const queue = this.pendingFollowups.get(threadKey);
		if (!queue || queue.length === 0) {
			return;
		}
		this.pendingFollowups.delete(threadKey);
		// Defer so the just-finished runner has fully transitioned to not-running
		// before the follow-up is re-evaluated (otherwise it would re-queue).
		setImmediate(() => {
			for (const event of queue) {
				this.handleEvent(event).catch((error: unknown) => {
					this.logger.error(
						`Failed to re-dispatch queued ${this.adapter.platformName} follow-up (thread ${threadKey})`,
						error instanceof Error ? error : new Error(String(error)),
					);
				});
			}
		});
	}

	private enqueueReply(sessionId: string, event: TEvent): void {
		const queue = this.pendingReplyEvents.get(sessionId) ?? [];
		queue.push(event);
		this.pendingReplyEvents.set(sessionId, queue);
		this.lastReplyEvent.set(sessionId, event);
	}

	private drainReplies(sessionId: string): TEvent[] {
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return [];
		this.pendingReplyEvents.delete(sessionId);
		return queue;
	}

	/**
	 * Discard all queued reply events for a session. Called when the runner
	 * rejects before emitting a final `result` — without this, a later
	 * resumeSession() on the same sessionId would pair the stale events with
	 * the first `result` of the new runner.
	 */
	private clearPendingReplies(sessionId: string): void {
		this.lastReplyEvent.delete(sessionId);
		this.pendingWorkNotificationKeys.delete(sessionId);
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return;
		this.logger.warn(
			`Discarding ${queue.length} pending ${this.adapter.platformName} reply event(s) for session ${sessionId} after runner error`,
		);
		this.pendingReplyEvents.delete(sessionId);
	}

	/**
	 * Create an empty workspace directory for a chat thread.
	 * Unlike repository-associated sessions, chat sessions use plain directories (not git worktrees).
	 */
	private async createWorkspace(
		threadKey: string,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			const sanitizedKey = threadKey.replace(/[^a-zA-Z0-9.-]/g, "_");
			const workspacePath = join(
				this.deps.cyrusHome,
				`${this.adapter.platformName}-workspaces`,
				sanitizedKey,
			);

			await mkdir(workspacePath, { recursive: true });

			return { path: workspacePath, isGitWorktree: false };
		} catch (error) {
			this.logger.error(
				`Failed to create ${this.adapter.platformName} workspace for thread ${threadKey}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a runner config for a chat session.
	 * Delegates to RunnerConfigBuilder for config assembly.
	 */
	private async buildRunnerConfig(
		workspacePath: string,
		workspaceName: string | undefined,
		systemPrompt: string,
		sessionId: string,
		resumeSessionId?: string,
	): Promise<AgentRunnerConfig> {
		const sessionLogger = this.logger.withContext({
			sessionId,
			platform: this.adapter.platformName,
		});

		// Read live values from the provider at session-build time
		const provider = this.deps.chatRepositoryProvider;
		const repository = provider.getDefaultRepository();
		const repositoryPaths = provider.getRepositoryPaths();
		const skillsConfig = this.deps.resolveSkillsConfig
			? await this.deps.resolveSkillsConfig({ repository, repositoryPaths })
			: {};

		return this.deps.runnerConfigBuilder.buildChatConfig({
			workspacePath,
			workspaceName,
			systemPrompt,
			sessionId,
			resumeSessionId,
			cyrusHome: this.deps.cyrusHome,
			platformName: this.adapter.platformName,
			linearWorkspaceId: provider.getDefaultLinearWorkspaceId(),
			repository,
			repositoryPaths,
			platformMcpConfigOverrides: this.deps.getPlatformMcpConfigOverrides?.(),
			plugins: skillsConfig.plugins,
			skills: skillsConfig.skills,
			logger: sessionLogger,
			onMessage: (message: SDKMessage) =>
				this.handleAgentMessage(sessionId, message),
			onError: (error: Error) => this.deps.onClaudeError(error),
		});
	}
}
