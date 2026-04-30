/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, LLMChatMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

type PlanTaskJournalEntry = {
	taskId: string;
	taskName: string;
	summary: string;
	explanation: string;
	codeSnippets: string[];
	presentedResponse: string;
	what: string;
	why: string;
	where: string;
	files: string[];
	status: 'pending' | 'in_progress' | 'completed';
	updatedAtISO: string;
}

const extractTagBlock = (s: string, tagName: string): string | null => {
	const match = s.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'))
	return match?.[1]?.trim() ?? null
}
const extractAllCodeBlocks = (s: string): string[] => {
	const matches = s.match(/```[\s\S]*?```/g)
	return matches?.map(m => m.trim()) ?? []
}

const planContainsGroundworkSteps = (plan: string): boolean => {
	const normalized = plan.toLowerCase()
	const suspiciousPatterns = [
		'generate a directory tree',
		'list the directory tree',
		'search the repo',
		'search the repository',
		'search the codebase',
		'find the file',
		'find the files',
		'locate the',
		'identify the .proto',
		'identify the proto',
		'identify the file',
		'identify the files',
		'open the ',
		'read the current',
		'inspect the codebase',
		'explore the codebase',
		'determine what updates are needed',
		'understand existing',
	]
	return suspiciousPatterns.some(pattern => normalized.includes(pattern))
}

const planHasStructuredStepHeadings = (plan: string): boolean => {
	return /(^|\n)#{2,3}\s+/.test(plan)
}

const formatStructuredMarkdownBlock = (raw: string, heading: string): string => {
	const trimmed = raw.trim()
	if (!trimmed) return `# ${heading}\n`

	const normalized = trimmed
		.replace(/\r\n/g, '\n')
		.replace(/^\s*[-*]\s+/gm, '- ')
		.replace(/(\d+)\.\s+/g, '\n$1. ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()

	const body = normalized.startsWith('#')
		? normalized
		: `# ${heading}\n\n${normalized}`

	return `${body.trim()}\n`
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}

		planModeState?: {
			taskJournal: PlanTaskJournalEntry[];
		}

		summarizedContext?: {
			text: string;
			summarizedUntilMessageIdx: number;
		};
	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
			planModeState: {
				taskJournal: [],
			},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<void>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>
	preparePlanReviewDraftInCurrentChat: () => Promise<void>
	submitPlanProceedInCurrentThread: () => Promise<void>
	submitPlanReviewFeedbackInCurrentThread: (feedback: string) => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	state: ThreadsState // allThreads is persisted, currentThread is not
	private _lastSuccessfulToolFingerprintOfThreadId: { [threadId: string]: string } = {}

	private _debugLogOfThreadId: { [threadId: string]: any[] } = {}
	private async _appendDebugLog(threadId: string, entry: any) {
		if (!this._debugLogOfThreadId[threadId]) this._debugLogOfThreadId[threadId] = [];
		this._debugLogOfThreadId[threadId].push({ timestamp: new Date().toISOString(), ...entry });
		await this._writeWorkspaceFile('void_agent_session.json', JSON.stringify(this._debugLogOfThreadId[threadId], null, 2));
	}

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}

		// always be in a thread
		this.openNewThread()


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}

	async preparePlanReviewDraftInCurrentChat() {
		const draft = `PLAN_REVIEW_FEEDBACK:
Please revise and replace the previous <plan> based on this feedback:


Important:
- Output ONLY a full replacement <plan> block.
- Do not execute tools.
- Remove outdated plan items and return a clean updated plan.`
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const mounted = await thread.state.mountedInfo?.whenMounted
		const textarea = mounted?.textAreaRef.current
		if (!textarea) return
		textarea.value = draft
		textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
		textarea.focus()
		const selectionStart = draft.indexOf('based on this feedback:') + 'based on this feedback:\n'.length
		const selectionEnd = draft.indexOf('\n\nImportant:')
		textarea.setSelectionRange(selectionStart, selectionEnd)
	}

	async submitPlanProceedInCurrentThread() {
		const nextTask = this._getPendingTasks(this.state.currentThreadId)[0]
		if (!nextTask) return

		const proceedMessage = `PLAN_PROCEED:
Execute the following task from the approved <plan>:

${nextTask}

Rules:
- Execute one tool call per response. After each tool result, you will be called again — continue until this task is done.
- If the task is already done (e.g. branch exists, file created), skip it.
- When you are completely finished with this task, output a <task_summary> and stop. Do NOT start the next task.
- If this is the final task, output a <walkthrough> after the <task_summary>.`
		await this.addUserMessageAndStreamResponse({ userMessage: proceedMessage, threadId: this.state.currentThreadId })
	}

	async submitPlanReviewFeedbackInCurrentThread(feedback: string) {
		const trimmedFeedback = feedback.trim()
		if (!trimmedFeedback) return
		const reviewMessage = `PLAN_REVIEW_FEEDBACK:
Please revise and replace the previous <plan> based on this feedback:
${trimmedFeedback}

Important:
- Output ONLY a full replacement <plan> block.
- Do not execute tools.
- Remove outdated plan items and return a clean updated plan.`
		await this.addUserMessageAndStreamResponse({ userMessage: reviewMessage, threadId: this.state.currentThreadId })
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	private _storeAllThreads(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}

	private _primaryWorkspaceURI() {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri
	}

	private async _writeWorkspaceFile(relativePath: string, content: string) {
		const workspaceURI = this._primaryWorkspaceURI()
		if (!workspaceURI) return
		const uri = URI.joinPath(workspaceURI, relativePath)
		await this._fileService.writeFile(uri, VSBuffer.fromString(content))
	}

	private async _openWorkspaceFile(relativePath: string) {
		const workspaceURI = this._primaryWorkspaceURI()
		if (!workspaceURI) return
		const uri = URI.joinPath(workspaceURI, relativePath)
		await this._commandService.executeCommand('vscode.open', uri)
	}

	private _taskJournalMarkdown(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return '# Plan Task Log\n\n_No task summaries yet._\n'
		const tasks = thread.state.planModeState?.taskJournal ?? []
		if (tasks.length === 0) return '# Plan Task Log\n\n_No task summaries yet._\n'
		const lines: string[] = ['# Plan Task Log', '']
		for (const task of tasks) {
			lines.push(`## ${task.taskId} - ${task.taskName}`)
			lines.push(`- Status: ${task.status}`)
			lines.push(`- Updated: ${task.updatedAtISO}`)
			lines.push(`- Summary: ${task.summary || '(none)'}`)
			lines.push(`- Explanation: ${task.explanation || '(none)'}`)
			lines.push(`- Where: ${task.where || '(none)'}`)
			lines.push('')
			lines.push('### Files')
			if (task.files.length === 0) lines.push('- (none)')
			else task.files.forEach(f => lines.push(`- \`${f}\``))
			lines.push('')
			lines.push('### Snippets')
			if (task.codeSnippets.length === 0) lines.push('_No snippets captured._')
			else task.codeSnippets.forEach(snippet => lines.push(`${snippet}\n`))
			lines.push('')
		}
		return lines.join('\n')
	}

	private _isMutatingTool(toolName: string): boolean {
		const readOnlyTools = new Set([
			'read_file',
			'ls_dir',
			'get_dir_tree',
			'search_pathnames_only',
			'search_for_files',
			'search_in_file',
			'read_lint_errors',
			'semantic_search',
		]);
		return !readOnlyTools.has(toolName);
	}

	private async _persistPlanArtifactsFromAssistant(threadId: string, assistantText: string) {
		const plan = extractTagBlock(assistantText, 'plan')
		if (plan) {
			await this._writeWorkspaceFile('implementation_plan.md', formatStructuredMarkdownBlock(plan, 'Implementation Plan'))
			await this._openWorkspaceFile('implementation_plan.md')
		}

		const walkthrough = extractTagBlock(assistantText, 'walkthrough')
		if (walkthrough) {
			await this._writeWorkspaceFile('walkthrough.md', formatStructuredMarkdownBlock(walkthrough, 'Plan Walkthrough'))
			await this._openWorkspaceFile('walkthrough.md')
		}
	}

	private _getFilesInspectedInCurrentThread(threadId: string): Set<string> {
		const thread = this.state.allThreads[threadId]
		if (!thread) return new Set()
		const files = new Set<string>()
		for (const m of thread.messages) {
			if (m.role === 'tool') {
				// Count successful reads/edits
				if (m.type === 'success') {
					if (m.name === 'read_file' || m.name === 'rewrite_file' || m.name === 'edit_file' || m.name === 'search_in_file') {
						const uri = (m.params as any).uri
						if (uri) files.add(uri.fsPath || uri)
					}
				}
				// Count failed read attempts as 'inspected' (so agent can conclude a file doesn't exist)
				else if (m.type === 'tool_error' || m.type === 'rejected') {
					if (m.name === 'read_file') {
						const uri = (m.params as any).uri
						if (uri) files.add(uri.fsPath || uri)
					}
				}
			}
		}
		return files
	}

	private _hasPerformedImpactAnalysis(threadId: string): boolean {
		const thread = this.state.allThreads[threadId]
		if (!thread) return false
		const searchTools = new Set(['search_for_files', 'semantic_search', 'search_in_file'])
		return thread.messages.some(m => m.role === 'tool' && m.type === 'success' && searchTools.has(m.name))
	}

	private _successfulToolMessagesForCurrentTask(threadId: string, opts: { onlyMutating?: boolean } = {}): Extract<ToolMessage<ToolName>, { type: 'success' }>[] {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []
		const messages = thread.messages
		let latestAssistantIdx = -1
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i].role === 'assistant') {
				latestAssistantIdx = i
				break
			}
		}
		let previousAssistantIdx = -1
		for (let i = latestAssistantIdx - 1; i >= 0; i -= 1) {
			if (messages[i].role === 'assistant') {
				previousAssistantIdx = i
				break
			}
		}
		const startIdx = previousAssistantIdx + 1
		const endIdx = latestAssistantIdx === -1 ? messages.length : latestAssistantIdx
		const toolMessages: Extract<ToolMessage<ToolName>, { type: 'success' }>[] = []
		for (let i = startIdx; i < endIdx; i += 1) {
			const message = messages[i]
			if (message.role === 'tool' && message.type === 'success') {
				if (opts.onlyMutating && !this._isMutatingTool(message.name)) {
					continue;
				}
				toolMessages.push(message)
			}
		}
		return toolMessages
	}

	private _collectToolTouchedFilesSincePreviousAssistant(threadId: string): string[] {
		const toolMessages = this._successfulToolMessagesForCurrentTask(threadId)
		const filesSet = new Set<string>()
		for (const message of toolMessages) {
			const params = message.params as any
			const uri = params?.uri?.fsPath ?? params?.uri
			if (typeof uri === 'string' && uri) filesSet.add(uri)
		}
		return [...filesSet]
	}

	private _hasSuccessfulGatherDiscoveryForCurrentTurn(threadId: string): boolean {
		const discoveryTools = new Set<ToolName>([
			'search_codebase',
			'read_file',
			'search_for_files',
			'search_pathnames_only',
			'search_in_file',
			'semantic_search',
		]);
		return this._successfulToolMessagesForCurrentTask(threadId).some(message => discoveryTools.has(message.name));
	}

	private _hasSuccessfulSearchCodebaseInThread(threadId: string): boolean {
		const thread = this.state.allThreads[threadId]
		if (!thread) return false
		return thread.messages.some(message =>
			message.role === 'tool' &&
			message.type === 'success' &&
			message.name === 'search_codebase'
		)
	}

	private _hasSuccessfulGatherDiscoveryInThread(threadId: string): boolean {
		const thread = this.state.allThreads[threadId]
		if (!thread) return false
		const discoveryTools = new Set<ToolName>([
			'search_codebase',
			'read_file',
			'search_for_files',
			'search_pathnames_only',
			'search_in_file',
			'semantic_search',
		])
		return thread.messages.some(message =>
			message.role === 'tool' &&
			message.type === 'success' &&
			discoveryTools.has(message.name)
		)
	}

	private async _recordPlanTaskSummaryIfPresent(threadId: string, assistantText: string): Promise<boolean> {
		const summaryBlock = extractTagBlock(assistantText, 'task_summary')
		if (!summaryBlock) return false

		const thread = this.state.allThreads[threadId]
		if (!thread) return false
		const now = new Date().toISOString()
		const taskId = extractTagBlock(summaryBlock, 'task_id') || `task-${thread.messages.length}`
		const taskName = extractTagBlock(summaryBlock, 'task_name') || `Task ${thread.messages.length}`
		const summaryText = extractTagBlock(summaryBlock, 'summary') || ''
		const explanation = extractTagBlock(summaryBlock, 'explanation') || ''
		const what = extractTagBlock(summaryBlock, 'what') || summaryBlock
		const why = extractTagBlock(summaryBlock, 'why') || ''
		const where = extractTagBlock(summaryBlock, 'where') || ''
		const statusRaw = (extractTagBlock(summaryBlock, 'status') || 'completed').toLowerCase()
		const status: PlanTaskJournalEntry['status'] =
			statusRaw === 'pending' ? 'pending'
				: statusRaw === 'in_progress' ? 'in_progress'
					: 'completed'
		if (status === 'completed' && this._successfulToolMessagesForCurrentTask(threadId, { onlyMutating: true }).length === 0) {
			console.warn(`[Void][AgentLoop][${threadId}] ignoring completed task_summary because no state-changing tool (edit, rewrite, command) succeeded during the current task window`)
			return false
		}

		const filesInSummary = (extractTagBlock(summaryBlock, 'files') || '')
			.split('\n')
			.map(line => line.replace(/^[-*\s`]+/, '').replace(/[`]/g, '').trim())
			.filter(Boolean)
		const filesFromTools = this._collectToolTouchedFilesSincePreviousAssistant(threadId)
		const files = [...new Set([...filesInSummary, ...filesFromTools])]
		const codeSnippets = extractAllCodeBlocks(summaryBlock)

		const prevJournal = thread.state.planModeState?.taskJournal ?? []
		const prevIdx = prevJournal.findIndex(t => t.taskId === taskId)
		const entry: PlanTaskJournalEntry = {
			taskId,
			taskName,
			summary: summaryText || what,
			explanation: explanation || why,
			codeSnippets,
			presentedResponse: summaryBlock,
			what,
			why,
			where,
			files,
			status,
			updatedAtISO: now
		}

		const nextJournal = prevIdx === -1
			? [...prevJournal, entry]
			: [
				...prevJournal.slice(0, prevIdx),
				{ ...prevJournal[prevIdx], ...entry },
				...prevJournal.slice(prevIdx + 1),
			]

		this._setThreadState(threadId, {
			planModeState: { taskJournal: nextJournal }
		}, true)
		await this._writeWorkspaceFile('plan_task_log.md', this._taskJournalMarkdown(threadId))
		await this._openWorkspaceFile('plan_task_log.md')
		return true
	}

	/**
	 * Returns the pending plan steps from the latest approved <plan> that are NOT
	 * yet recorded as 'completed' in the task journal. Returns empty array if no plan exists.
	 */
	private _getPendingTasks(threadId: string): string[] {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		// Find the latest plan from assistant messages
		const planMessage = findLast(thread.messages, m => m.role === 'assistant' && !!extractTagBlock(m.displayContent, 'plan'))
		if (!planMessage || planMessage.role !== 'assistant') return []

		const plan = extractTagBlock(planMessage.displayContent, 'plan') ?? ''

		// Map headings as distinct tasks
		let allTasks = plan.split(/(?:^|\n)(?=##\s+)/)
			.filter(s => s.trim().startsWith('##'))
			.map(s => s.trim())

		// Fallback 1: split by numbered lists or bullets
		if (allTasks.length === 0) {
			allTasks = plan.split(/(?:^|\n)(?=#{3}\s+|\d+\.\s+|-\s+\[[ x]\]\s+|-\s+|\*\s+)/)
				.map(s => s.trim())
				.filter(s => s.length > 0 && /^(#{3}\s+|\d+\.\s+|-\s+\[[ x]\]\s+|-\s+|\*\s+)/.test(s))
		}

		// Fallback 2: split by newlines (ignoring short/empty lines)
		if (allTasks.length === 0) {
			allTasks = plan.split(/\n/)
				.map(s => s.trim())
				.filter(s => s.length > 5 && !s.toLowerCase().includes('implementation plan') && !s.includes('---'))
		}

		// Absolute fallback: treat entire plan as 1 task
		if (allTasks.length === 0) {
			allTasks = plan.trim() ? [plan.trim()] : []
		}

		const completedCount = (thread.state.planModeState?.taskJournal ?? []).filter(t => t.status === 'completed').length
		return allTasks.slice(completedCount)
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false
		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	private async _appendBrainFile(threadId: string, content: string) {
		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		if (!workspaceFolders || workspaceFolders.length === 0) return;

		const baseUri = workspaceFolders[0].uri;
		const brainDir = URI.joinPath(baseUri, '.void', 'session_memory');
		const brainUri = URI.joinPath(brainDir, `${threadId}.md`);

		try {
			try { await this._fileService.createFolder(brainDir); } catch (e) { }
			let existingContent = '';
			try {
				const fileContent = await this._fileService.readFile(brainUri);
				existingContent = fileContent.value.toString() + '\n\n';
			} catch (e) {
				existingContent = `# Session Brain Memory\nThread ID: ${threadId}\n\n`;
			}
			await this._fileService.writeFile(brainUri, VSBuffer.fromString(existingContent + content));
		} catch (e) {
			console.error('Failed to write to brain file', e);
		}
	}

	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj },
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean, isRepetition?: boolean }> => {
		const toolCallStart = Date.now();
		console.log(`[Void][AgentLoop][${threadId}] _runToolCall start name=${toolName} toolId=${toolId} preapproved=${opts.preapproved} mcpServer=${mcpServerName ?? 'builtin'}`);
		this._appendDebugLog(threadId, {
			direction: 'tool_execution_start',
			toolName,
			params: opts.unvalidatedToolParams
		}).catch(e => console.error(e));

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
			// once validated, add checkpoint for edit
			if (toolName === 'edit_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }) }
			if (toolName === 'rewrite_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }) }

			// intercept duplicate reads to save context memory
			if (toolName === 'read_file' || toolName === 'search_in_file') {
				const params = toolParams as BuiltinToolCallParams['read_file'] | BuiltinToolCallParams['search_in_file']
				const fsPath = params.uri.fsPath
				if (this._getFilesInspectedInCurrentThread(threadId).has(fsPath)) {
					const errorMessage = `File ${fsPath} has already been inspected in this session. You do not need to read it again unless you suspect it has changed.`
					this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', rawParams: opts.unvalidatedToolParams, params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, mcpServerName })
					return { isRepetition: true }
				}
			}

			// 2. if tool requires approval, break from the loop, awaiting approval

			let approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools';
			if (!isBuiltInTool) {
				const editsTools = ['apply_patch', 'multi_edit', 'delete_file', 'rename_file', 'mkdir', 'write_file', 'create_new_file'];
				const terminalTools = ['run_command', 'sed'];
				if (editsTools.includes(toolName)) {
					approvalType = 'edits';
				} else if (terminalTools.includes(toolName)) {
					approvalType = 'terminal';
				} else {
					// Read-only MCP tools do not require approval
					approvalType = undefined as any;
				}
			}
			if (approvalType) {
				const autoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType]
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				if (!autoApprove) {
					console.log(`[Void][AgentLoop][${threadId}] tool=${toolName} awaiting user approval after ${Date.now() - toolCallStart}ms`);
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })

			if (isBuiltInTool) {
				const { result, interruptTool } = await this._toolsService.callTool[toolName](toolParams as any)
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				resolveInterruptor(() => { })

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					toolName: toolName,
					params: toolParams
				})).result
			}

			if (interrupted) {
				console.log(`[Void][AgentLoop][${threadId}] tool=${toolName} interrupted after ${Date.now() - toolCallStart}ms`);
				return { interrupted: true }
			} // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) {
				console.log(`[Void][AgentLoop][${threadId}] tool=${toolName} interrupted during error path after ${Date.now() - toolCallStart}ms`);
				return { interrupted: true }
			} // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			console.error(`[Void][AgentLoop][${threadId}] tool=${toolName} failed after ${Date.now() - toolCallStart}ms: ${errorMessage}`);
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			this._appendDebugLog(threadId, { direction: 'tool_execution_error', toolName, error: errorMessage }).catch(e => console.error(e));
			return {}
		}

		// PIV: Before editing, ensure file was read
		if (toolName === 'edit_file' || toolName === 'rewrite_file') {
			const uri = (toolParams as any).uri
			const fsPath = uri?.fsPath || uri
			if (fsPath && !this._getFilesInspectedInCurrentThread(threadId).has(fsPath)) {
				const errorMsg = `Error: You are trying to edit ${fsPath} but you haven't read it in this session yet. You MUST read a file to understand its content and context before making changes. Please use read_file first.`
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMsg, name: toolName, content: errorMsg, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				return {}
			}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			this._appendDebugLog(threadId, { direction: 'tool_execution_error', toolName, error: errorMessage }).catch(e => console.error(e));
			return {}
		}

		// 5. add to history and keep going
		const fingerprint = `${toolName}:${JSON.stringify(opts.unvalidatedToolParams)}`
		const isRepetition = this._lastSuccessfulToolFingerprintOfThreadId[threadId] === fingerprint
		this._lastSuccessfulToolFingerprintOfThreadId[threadId] = fingerprint

		const paramsStr = typeof opts.unvalidatedToolParams === 'string' ? opts.unvalidatedToolParams : JSON.stringify(opts.unvalidatedToolParams, null, 2);
		this._appendBrainFile(threadId, `## Tool Execution: ${toolName}\n**Parameters:**\n\`\`\`json\n${paramsStr}\n\`\`\`\n**Result:**\n\`\`\`\n${toolResultStr}\n\`\`\``).catch(e => console.error(e));

		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
		console.log(`[Void][AgentLoop][${threadId}] tool=${toolName} succeeded in ${Date.now() - toolCallStart}ms`);
		this._appendDebugLog(threadId, { direction: 'tool_execution_result', toolName, result: toolResultStr }).catch(e => console.error(e));
		return { isRepetition }
	};


	// ----------------------------------------------------------------------------------------------------------------
	// Context Summarizer (Async Background Task)
	private _isSummarizingOfThreadId: Record<string, boolean> = {};

	private async _backgroundSummarizeContext(threadId: string) {
		if (this._isSummarizingOfThreadId[threadId]) return;
		this._isSummarizingOfThreadId[threadId] = true;

		try {
			const thread = this.state.allThreads[threadId];
			if (!thread) return;

			// We need a chunk of at least 6 messages before the last 3.
			const lastSummarizedIdx = thread.state.summarizedContext?.summarizedUntilMessageIdx ?? -1;
			const targetUntilIdx = thread.messages.length - 4; // up to the 4th from last

			if (targetUntilIdx - lastSummarizedIdx < 6) return; // Wait until we have enough new messages

			const messagesToSummarize = thread.messages.slice(lastSummarizedIdx + 1, targetUntilIdx + 1);
			if (messagesToSummarize.length === 0) return;

			const chatChunk = messagesToSummarize.map(m => {
				if (m.role === 'tool') return `TOOL (${m.name}): [details omitted, visible in session memory]`;
				if (m.role === 'user') return `USER: ${m.content}`;
				if (m.role === 'assistant') {
					if (m.displayContent || m.anthropicReasoning) {
						return `ASSISTANT:\n${m.displayContent || '[reasoning emitted]'}`;
					}
					return `ASSISTANT: [Called tool]`;
				}
				return null;
			}).filter(Boolean).join('\n---\n');

			const previousSummaryObj = thread.state.summarizedContext;
			const previousSummaryStr = previousSummaryObj ? `\n\nPrevious Summary block that you should merge this new information with:\n<previous_summary>\n${previousSummaryObj.text}\n</previous_summary>` : '';

			const promptObj: LLMChatMessage = {
				role: 'user',
				content: `Please read the following conversation chunk and provide an updated, concise summary of the architectural context, user intent, discovered codebase structure, and what the agent has successfully accomplished so far.
Do not emit raw code files.
Do not hallucinate details.
Keep it strictly under 500 words.
${previousSummaryStr}

New Conversation Chunk:
<conversation_chunk>
${chatChunk}
</conversation_chunk>`
			};

			const { chatMode } = this._settingsService.state.globalSettings;
			const overridesOfModel = this._settingsService.state.overridesOfModel

			// Hardcode explicitly to gpt-4o-mini for the background summarizer
			const modelSelection: ModelSelection = { providerName: 'localProxy', modelName: 'gpt-4o-mini' };
			const modelSelectionOptions = (this._settingsService.state.optionsOfModelSelection['Chat'] as any)[modelSelection?.providerName ?? '']?.[modelSelection?.modelName ?? '']

			if (!modelSelection) return;

			await new Promise<void>((resolve) => {
				this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: [promptObj],
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Background Summarizer`, loggingExtras: { threadId } },
					separateSystemMessage: "You are a context compresser.",
					onText: () => { },
					onFinalMessage: async ({ fullText }) => {
						const targetThread = this.state.allThreads[threadId];
						if (targetThread) {
							targetThread.state.summarizedContext = { text: fullText.trim(), summarizedUntilMessageIdx: targetUntilIdx };
							if (threadId === this.state.currentThreadId) this._onDidChangeCurrentThread.fire();
						}
						console.log(`[Void][BackgroundSummarizer][${threadId}] Summary completed until message ${targetUntilIdx}.`);
						resolve();
					},
					onError: async (error) => {
						console.error(`[Void][BackgroundSummarizer] Error:`, error);
						resolve();
					},
					onAbort: () => { resolve(); }
				});
			});
		} catch (e) {
			console.error(`[Void][BackgroundSummarizer] Exception:`, e);
		} finally {
			this._isSummarizingOfThreadId[threadId] = false;
		}
	}
	// ----------------------------------------------------------------------------------------------------------------



	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
	}) {


		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined
		let correctiveRetryInstruction: string | null = null
		let autoContinueNudges = 0
		const MAX_AUTO_CONTINUE_NUDGES = 3 // safety cap to prevent infinite loops
		let totalCorrectiveRetries = 0
		const MAX_TOTAL_CORRECTIVE_RETRIES = 5 // safety cap for overall corrective retries

		let cachedContext: any = undefined;

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params })
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })

			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			// [Context Summarizer] Fire-and-forget background job to compress older history
			this._backgroundSummarizeContext(threadId).catch(console.error);

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			const prepareStart = Date.now();
			console.log(`[Void][AgentLoop][${threadId}] preparing chat messages (iteration=${nMessagesSent}, mode=${chatMode}, history=${chatMessages.length})`);
			const { messages, separateSystemMessage, cachedContext: newCachedContext } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				cachedContext,
				threadId,
				summarizedContext: this.state.allThreads[threadId]?.state.summarizedContext,
			})
			cachedContext = newCachedContext;
			console.log(`[Void][AgentLoop][${threadId}] prepared chat messages in ${Date.now() - prepareStart}ms (iteration=${nMessagesSent}, outbound=${messages.length}, separateSystem=${!!separateSystemMessage})`);

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCall?: RawToolCallObj, info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				const outboundMessages: LLMChatMessage[] = correctiveRetryInstruction
					? [
						...messages,
						{
							role: 'user',
							content: correctiveRetryInstruction,
						} as LLMChatMessage
					]
					: messages
				if (correctiveRetryInstruction) {
					totalCorrectiveRetries++;
					if (totalCorrectiveRetries >= MAX_TOTAL_CORRECTIVE_RETRIES) {
						console.error(`[Void][AgentLoop][${threadId}] Max corrective retries reached (${MAX_TOTAL_CORRECTIVE_RETRIES}), stopping loop.`);
						shouldRetryLLM = false;
						shouldSendAnotherMessage = false;
						break;
					}
					console.warn(`[Void][AgentLoop][${threadId}] retrying iteration=${nMessagesSent} with corrective plan instruction (${totalCorrectiveRetries}/${MAX_TOTAL_CORRECTIVE_RETRIES})`);
				}

				this._appendDebugLog(threadId, {
					iteration: nMessagesSent,
					direction: 'request',
					outboundMessages
				}).catch(e => console.error(e));

				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: outboundMessages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: separateSystemMessage,
					onText: ({ fullText, fullReasoning, toolCall }) => {
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, }) => {
						this._appendDebugLog(threadId, {
							iteration: nMessagesSent,
							direction: 'response',
							fullText, fullReasoning, toolCall
						}).catch(e => console.error(e));

						console.log(`[Void][AgentLoop][${threadId}] final LLM message received (iteration=${nMessagesSent}, textLength=${fullText.length}, reasoningLength=${fullReasoning.length}, toolCall=${toolCall?.name ?? 'none'}, hasPlan=${fullText.includes('<plan>')})`);
						resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning } }) // resolve with tool calls
					},
					onError: async (error) => {
						console.error(`[Void][AgentLoop][${threadId}] LLM error on iteration=${nMessagesSent}: ${error.message}`);
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {

					if (llmRes.error?.message === 'Void: Response from model was empty.' && !correctiveRetryInstruction) {
						correctiveRetryInstruction = 'Your previous response was completely empty. Please try again and complete your thoughts. Remember to use a tool call if necessary.';
						nAttempts = 0; // Reset network attempts to give the semantic retry a full chance
					}

					// error, should retry
					if (nAttempts < CHAT_RETRIES) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(RETRY_DELAY)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const { error } = llmRes
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
						if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

						this._setStreamState(threadId, { isRunning: undefined, error })
						this._addUserCheckpoint({ threadId })
						return
					}
				}

				// llm res success
				let { toolCall, info } = llmRes

				// --- Custom Fix: Parse RAW JSON-RPC output from stubborn models natively! ---
				if (!toolCall && info.fullText && info.fullText.trim().startsWith('{') && info.fullText.trim().endsWith('}')) {
					try {
						const candidateObj = JSON.parse(info.fullText.trim());

						// Look for the method name in a variety of common keys
						let methodName = candidateObj.tool || candidateObj.command || candidateObj.method || candidateObj.name || candidateObj.function?.name || candidateObj.plugin;

						// Special case: if 'id' is a valid tool name and methodName is missing, treat 'id' as the name
						if (!methodName && typeof candidateObj.id === 'string' && isABuiltinToolName(candidateObj.id)) {
							methodName = candidateObj.id;
						}

						const paramsObj = candidateObj.params || candidateObj.arguments || candidateObj.function?.arguments || candidateObj.args || candidateObj.command_params;

						const paramsObjParsed = typeof paramsObj === 'string' ? JSON.parse(paramsObj) : (paramsObj || {});

						// Determine a persistent ID
						let uuidForJsonTool = candidateObj.call_id || generateUuid();
						// Only use candidateObj.id as uuid if it wasn't already consumed as the methodName
						if (candidateObj.id && candidateObj.id !== methodName) {
							uuidForJsonTool = candidateObj.id;
						}

						if (methodName && typeof methodName === 'string') {
							const sanitizedParams: Record<string, string> = {};
							for (const key in paramsObjParsed) {
								if (typeof paramsObjParsed[key] === 'object') {
									sanitizedParams[key] = JSON.stringify(paramsObjParsed[key]);
								} else {
									sanitizedParams[key] = String(paramsObjParsed[key]);
								}
							}

							console.warn(`[Void][AgentLoop][${threadId}] Discovered JSON tool string inside raw text! Re-hydrating tool: ${methodName}`);
							toolCall = {
								name: methodName as any,
								rawParams: sanitizedParams as any,
								isDone: true,
								doneParams: Object.keys(sanitizedParams) as any,
								id: uuidForJsonTool
							};

							info.fullText = ''; // Hide JSON from the stream text
						}
					} catch (e) {
						console.error(`[Void][AgentLoop] JSON extraction failed:`, e);
					}
				}
				// ----------------------------------------------------------------------------

				console.log(`[Void][AgentLoop][${threadId}] LLM iteration=${nMessagesSent} completed with toolCall=${toolCall?.name ?? 'none'} textLength=${info.fullText.length}`);

				const latestAssistantPlanAlreadyExists = chatMessages.some(m => m.role === 'assistant' && !!extractTagBlock(m.displayContent, 'plan'))
				const hasSuccessfulToolContext = chatMessages.some(m => m.role === 'tool' && m.type === 'success')
				const hasPlanBlock = !!extractTagBlock(info.fullText, 'plan')
				const extractedPlan = extractTagBlock(info.fullText, 'plan') ?? ''
				const needsInitialPlanRetry =
					chatMode === 'plan' &&
					!latestAssistantPlanAlreadyExists &&
					hasSuccessfulToolContext &&
					!hasPlanBlock &&
					!toolCall &&
					!correctiveRetryInstruction

				const needsInitialDiscoveryRetry =
					chatMode === 'plan' &&
					!latestAssistantPlanAlreadyExists &&
					!hasSuccessfulToolContext &&
					!toolCall &&
					!correctiveRetryInstruction

				const needsPlanGroundingRetry =
					chatMode === 'plan' &&
					!latestAssistantPlanAlreadyExists &&
					hasSuccessfulToolContext &&
					hasPlanBlock &&
					!toolCall &&
					!correctiveRetryInstruction &&
					(
						planContainsGroundworkSteps(extractedPlan) ||
						!planHasStructuredStepHeadings(extractedPlan)
					)

				const needsSearchCodebaseBeforePlanRetry =
					chatMode === 'plan' &&
					!latestAssistantPlanAlreadyExists &&
					hasSuccessfulToolContext &&
					!this._hasSuccessfulSearchCodebaseInThread(threadId) &&
					!toolCall &&
					!correctiveRetryInstruction

				if (needsSearchCodebaseBeforePlanRetry) {
					correctiveRetryInstruction = 'Phase 1 incomplete. Use the search_codebase tool now to perform repository discovery.'
					console.warn(`[Void][AgentLoop][${threadId}] plan mode response arrived without search_codebase; scheduling discovery retry`);
					shouldRetryLLM = true
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
					continue
				}

				if (needsInitialDiscoveryRetry) {
					correctiveRetryInstruction = 'Phase 1 incomplete. Output a discovery tool call now (e.g. search_codebase) to gather more context.'
					console.warn(`[Void][AgentLoop][${threadId}] plan mode response arrived before any successful discovery tool results; scheduling discovery retry`);
					shouldRetryLLM = true
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
					continue
				}

				const needsDiscoveryBeforePlanRetry =
					chatMode === 'plan' &&
					!latestAssistantPlanAlreadyExists &&
					!hasSuccessfulToolContext &&
					hasPlanBlock &&
					!toolCall &&
					!correctiveRetryInstruction

				if (needsDiscoveryBeforePlanRetry) {
					correctiveRetryInstruction = [
						'Phase 1 (Discovery) is incomplete.',
						'Your previous <plan> was created too early.',
						'Do not create the first plan before repository discovery (including `search_codebase` and `read_file`) is complete.',
						'After discovery results are available, move to Phase 2 (Planning) and write the first <plan>.',
					].join(' ')
					console.warn(`[Void][AgentLoop][${threadId}] plan mode response contained a plan before any successful discovery tool results; scheduling discovery retry`);
					shouldRetryLLM = true
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
					continue
				}

				if (needsInitialPlanRetry) {
					correctiveRetryInstruction = [
						'Your previous response did not follow Plan Mode.',
						'Respond again with ONLY a single <plan>...</plan> block.',
						'Do not include any prose before or after the <plan> block.',
						'Do not apologize.',
						'Do not ask a follow-up question.',
					].join(' ')
					console.warn(`[Void][AgentLoop][${threadId}] plan mode response missing <plan>; scheduling one corrective retry`);
					shouldRetryLLM = true
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
					continue
				}

				if (needsPlanGroundingRetry) {
					correctiveRetryInstruction = [
						'Your previous <plan> is invalid.',
						'Do not include groundwork, search, grep, locate, identify, open, inspect, or directory-tree tasks inside the plan.',
						'Finish all lightweight repository discovery before writing the plan.',
						'The plan is for execution only.',
						'Rewrite the plan using concrete discovered files/modules when known.',
						'Format the plan with markdown step headings like "## Step 1: ...".',
						'Under each step heading, include flat bullet points describing exactly what will be done in that step.',
						'Respond again with ONLY a single replacement <plan>...</plan> block.',
					].join(' ')
					console.warn(`[Void][AgentLoop][${threadId}] plan mode response contained groundwork tasks or missing step headings; scheduling one corrective retry`);
					shouldRetryLLM = true
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
					continue
				}

				// Plan Grounding Verification
				if (chatMode === 'plan' && hasPlanBlock) {
					const filesInspected = this._getFilesInspectedInCurrentThread(threadId)
					const workspaceFolders = this._workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

					// Heuristic to find paths in plan, and normalize them to absolute
					const rawPathsInPlan = (extractedPlan.match(/(?:\/|[A-Za-z]:\\)[\w\-\.\/\\\ ]+/g) || [])
						.map(p => p.trim())
						.filter(p => (p.includes('.') || p.includes('/') || p.includes('\\')) && !p.endsWith('/') && !p.endsWith('\\'))

					const pathsInPlan = rawPathsInPlan.map(p => {
						// If already absolute, return as is
						if (p.startsWith('/') || /^[A-Za-z]:\\/.test(p)) {
							// Check if it exists in filesInspected as is
							if (filesInspected.has(p)) return p
							// If starts with /, try prepending workspace folders
							if (p.startsWith('/')) {
								for (const f of workspaceFolders) {
									const abs = (f + p).replace(/\/\//g, '/')
									if (filesInspected.has(abs)) return abs
								}
							}
						}
						return p
					})

					const uninspectedFiles = rawPathsInPlan.filter((rawP, i) => {
						const absP = pathsInPlan[i]
						return !filesInspected.has(absP) && !filesInspected.has(rawP)
					})

					if (uninspectedFiles.length > 0) {
						correctiveRetryInstruction = [
							'Your <plan> references implementation files that have not been inspected yet:',
							...uninspectedFiles.map(f => `- ${f}`),
							'',
							'You MUST read and understand these files using read_file BEFORE proposing an implementation plan.',
							'This ensures your plan is grounded in the actual codebase state and avoids assumptions.',
							'Please perform the necessary discovery now, and then re-propose the plan.',
						].join('\n')
						console.warn(`[Void][AgentLoop][${threadId}] plan rejected due to uninspected grounding files:`, uninspectedFiles);
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						continue
					}

					// Environmental Grounding (Impact Analysis) Check
					// If the plan touches multiple files or seems complex, require impact analysis
					const numSteps = (extractedPlan.match(/^##\ Step/gm) || []).length
					if ((pathsInPlan.length > 1 || numSteps > 2) && !this._hasPerformedImpactAnalysis(threadId)) {
						correctiveRetryInstruction = [
							'Your <plan> appears complex, but you have not yet performed an Impact Analysis.',
							'You MUST use search tools (`semantic_search`, `search_for_files`) to find callers and understand dependencies before modifying existing code.',
							'This ensures your changes do not break the build elsewhere.',
							'Please perform the necessary impact discovery now, and then re-propose the plan.',
						].join('\n')
						console.warn(`[Void][AgentLoop][${threadId}] plan rejected due to lack of impact analysis`);
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						continue
					}
				}

				correctiveRetryInstruction = null

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning })
				if (chatMode === 'plan') {
					await this._persistPlanArtifactsFromAssistant(threadId, info.fullText)
				}

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// call tool if there is one
				if (toolCall) {
					const mcpTools = this._mcpService.getMCPTools()
					const mcpTool = mcpTools?.find(t => t.name === toolCall.name)

					const { awaitingUserApproval, interrupted, isRepetition } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams })
					if (interrupted) {
						this._setStreamState(threadId, undefined)
						return
					}
					if (isRepetition) {
						if (chatMode === 'gather' && this._hasSuccessfulGatherDiscoveryInThread(threadId)) {
							console.warn(`[Void][AgentLoop][${threadId}] gather mode hit repeated tool call after successful discovery; ending loop`);
						}
						else {
							console.warn(`[Void][AgentLoop][${threadId}] detected identical tool repetition; injecting repetition error nudge`);
							this._addMessageToThread(threadId, {
								role: 'user',
								content: `Error: You are repeating the same tool call with identical parameters. This indicates a loop. Please adjust your approach, search for different terms, or provide a new plan if you are stuck.`,
								state: { stagingSelections: [], isBeingEdited: false },
								displayContent: `[Error: Repetition detected]`,
							} as any)
							shouldSendAnotherMessage = true
						}
					}
					else if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
					else { shouldSendAnotherMessage = true }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}
				else {
					// No tool call returned — model thinks it's done.

					const hasTaskSummary = !!extractTagBlock(info.fullText, 'task_summary')
					const hasWalkthrough = !!extractTagBlock(info.fullText, 'walkthrough')
					const isPlanProposal = !!extractTagBlock(info.fullText, 'plan')
					const hasSuccessfulGatherDiscovery = chatMode === 'gather'
						? (this._hasSuccessfulGatherDiscoveryForCurrentTurn(threadId) || this._hasSuccessfulGatherDiscoveryInThread(threadId))
						: false
					const recordedTaskSummary = chatMode === 'plan'
						? await this._recordPlanTaskSummaryIfPresent(threadId, info.fullText)
						: false

					const currentMessages = this.state.allThreads[threadId]?.messages ?? []
					const previousUserMsgForInfo = [...currentMessages].reverse().find(msg => msg.role === 'user');
					const wasLastResultFormatError = previousUserMsgForInfo && typeof previousUserMsgForInfo.content === 'string' && previousUserMsgForInfo.content.includes('Error: Invalid LLM output format:');

					if (chatMode === 'plan' && !toolCall && !hasTaskSummary && !hasWalkthrough && isPlanProposal) {
						console.log(`[Void][AgentLoop][${threadId}] plan proposed; awaiting user review/proceed`);
						isRunningWhenEnd = 'awaiting_user'
					}
					const pendingTasks = (chatMode === 'plan' || chatMode === 'agent') ? this._getPendingTasks(threadId) : []
					const pendingSteps = pendingTasks.length

					if (wasLastResultFormatError && autoContinueNudges < MAX_AUTO_CONTINUE_NUDGES) {
						autoContinueNudges++
						console.warn(`[Void][AgentLoop][${threadId}] model stopped instead of fixing format error; injecting syntax error nudge ${autoContinueNudges}/${MAX_AUTO_CONTINUE_NUDGES}`)

						this._addMessageToThread(threadId, {
							role: 'user',
							content: `Your previous tool call failed due to a syntax format error. You must fix the formatting syntax and retry.`,
							state: { stagingSelections: [], isBeingEdited: false },
							displayContent: `[Auto-continue: Syntax error nudge injected]`,
						} as any)

						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					}
					else if (chatMode === 'plan' && hasTaskSummary && !recordedTaskSummary && !hasWalkthrough && autoContinueNudges < MAX_AUTO_CONTINUE_NUDGES) {
						autoContinueNudges++
						console.warn(`[Void][AgentLoop][${threadId}] model emitted task_summary without successful tool evidence; injecting corrective nudge ${autoContinueNudges}/${MAX_AUTO_CONTINUE_NUDGES}`)

						this._addMessageToThread(threadId, {
							role: 'user',
							content: `Your <task_summary> was not accepted because no tool call completed successfully for the current task. Continue the same task by emitting a real tool call now. Do not summarize or move to the next task until the necessary tool work has actually completed.`,
							state: { stagingSelections: [], isBeingEdited: false },
							displayContent: `[Auto-continue: Task summary rejected]`,
						} as any)

						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					}
					else if (chatMode === 'plan' && hasTaskSummary && recordedTaskSummary && !hasWalkthrough) {
						// The previous task was confirmed complete by the task summary!
						// It has already been saved to the journal so _getPendingTasks omits it.
						const nextTask = pendingTasks[0]
						if (nextTask) {
							// Feed the next task immediately
							this._addMessageToThread(threadId, {
								role: 'user',
								content: `The previous task is complete. Now execute the next task:\n\n${nextTask}\n\nWhen you are completely finished with this task, output a <task_summary> and stop. Do NOT emit a tool call alongside the <task_summary>. If this is the final task, please output a <walkthrough> after the <task_summary>.`,
								state: { stagingSelections: [], isBeingEdited: false },
								displayContent: `[Queue: Next task dispatched]`,
							} as any)
							shouldSendAnotherMessage = true
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
						} else if (pendingSteps === 0) {
							// Done with all tasks
							this._addMessageToThread(threadId, {
								role: 'user',
								content: `All tasks from the plan are complete! Please output a <walkthrough> to summarize the final results.`,
								state: { stagingSelections: [], isBeingEdited: false },
								displayContent: `[Queue: All tasks done]`,
							} as any)
							shouldSendAnotherMessage = true
							this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
						}
					}
					else if (chatMode === 'plan' && hasWalkthrough && this._successfulToolMessagesForCurrentTask(threadId, { onlyMutating: true }).length === 0 && autoContinueNudges < MAX_AUTO_CONTINUE_NUDGES) {
						autoContinueNudges++
						console.warn(`[Void][AgentLoop][${threadId}] model emitted walkthrough without successful tool evidence; injecting corrective nudge ${autoContinueNudges}/${MAX_AUTO_CONTINUE_NUDGES}`)

						this._addMessageToThread(threadId, {
							role: 'user',
							content: `Walkthrough rejected: no state-changing tool call succeeded recently. Execute real tool calls to implement changes first.`,
							state: { stagingSelections: [], isBeingEdited: false },
							displayContent: `[Auto-continue: Walkthrough rejected]`,
						} as any)

						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					}
					else if (pendingSteps > 0 && !hasWalkthrough && !isPlanProposal && autoContinueNudges < MAX_AUTO_CONTINUE_NUDGES) {
						autoContinueNudges++
						console.warn(`[Void][AgentLoop][${threadId}] model stopped without tool call but ${pendingSteps} plan steps remain; injecting auto-continue nudge ${autoContinueNudges}/${MAX_AUTO_CONTINUE_NUDGES}`)

						// Inject a corrective user message into the thread so the model sees it
						this._addMessageToThread(threadId, {
							role: 'user',
							content: `Task incomplete. You MUST emit a tool call now to continue.`,
							state: { stagingSelections: [], isBeingEdited: false },
							displayContent: `[Auto-continue: Nudge injected]`,
						} as any)

						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					}
					else if (!hasPlanBlock && chatMode === 'plan' && autoContinueNudges < MAX_AUTO_CONTINUE_NUDGES) {
						autoContinueNudges++
						console.warn(`[Void][AgentLoop][${threadId}] model stopped without tool call before plan; injecting auto-continue nudge ${autoContinueNudges}/${MAX_AUTO_CONTINUE_NUDGES}`)

						this._addMessageToThread(threadId, {
							role: 'user',
							content: `Incomplete response. You MUST emit a tool call now to gather more context or execute changes.`,
							state: { stagingSelections: [], isBeingEdited: false },
							displayContent: `[Auto-continue: Nudge injected]`,
						} as any)

						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					}
					else if (chatMode === 'gather' && hasSuccessfulGatherDiscovery) {
						console.log(`[Void][AgentLoop][${threadId}] gather mode received text answer after successful discovery; ending loop`);
					}
					else if (chatMode === 'gather' && autoContinueNudges < MAX_AUTO_CONTINUE_NUDGES) {
						autoContinueNudges++
						console.warn(`[Void][AgentLoop][${threadId}] gather mode stopped without tool call; injecting discovery nudge ${autoContinueNudges}/${MAX_AUTO_CONTINUE_NUDGES}`)

						this._addMessageToThread(threadId, {
							role: 'user',
							content: `You are in Gather mode and you did not emit a tool call. Do not stop with prose. Emit a real repository discovery tool call now. For implementation, owner, caller, definition, registration, or handler questions, prefer search_codebase first instead of get_dir_tree unless the task is explicitly about repository structure.`,
							state: { stagingSelections: [], isBeingEdited: false },
							displayContent: `[Auto-continue: Gather nudge injected]`,
						} as any)

						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					}
					else {
						console.log(`[Void][AgentLoop][${threadId}] ending loop after iteration=${nMessagesSent} because no tool call was returned`);
					}
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voidModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const { model } = this._voidModelService.getModel(uri)
		if (!model) return // should never happen
		const diffAreasSnapshot = this._editCodeService.getVoidFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			console.error(`[Void][AgentLoop][${threadId}] unhandled crash in agent loop:`, e)
			// SAFETY NET: always clear isRunning so the UI doesn't lock permanently
			this._setStreamState(threadId, undefined)
			this._addUserCheckpoint({ threadId })
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: instructions, selections: currSelns, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state
		for (const threadId in currentThreads) {
			if (currentThreads[threadId]!.messages.length === 0) {
				// switch to the existing empty thread and exit
				this.switchToThread(threadId)
				return
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject()

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
