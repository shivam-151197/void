import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { IContextGatheringService } from './contextGatheringService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { formatGatheredContextForPrompt, summarizeGatheredContextForLog } from '../common/contextGathering/contextGatherer.js';

export const EMPTY_MESSAGE = '(empty message)'



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}

const extractTagBlock = (s: string, tagName: string): string | null => {
	const match = s.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'))
	return match?.[1]?.trim() ?? null
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const TRIM_TO_LEN_ASSISTANT = 1000
const TRIM_TO_LEN_TOOL = 16000
const TRIM_TO_LEN_USER = 2000




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant') {
			prevMsg.tool_calls = [{
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				}
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages[i] = {
				role: 'user',
				content: currMsg.content,
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') prevMsg.content = [{ type: 'text', text: prevMsg.content }]
				prevMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			}
			continue
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .voidrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = message.content.length

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += m.content.length }
	const charsNeedToTrim = totalLen - Math.max(
		(contextWindow - reservedOutputTokenSpace) * CHARS_PER_TOKEN, // can be 0, in which case charsNeedToTrim=everything, bad
		5_000 // ensure we don't trim at least 5k chars (just a random small value)
	)


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		// if can finish here, do
		const trimToLen = m.role === 'tool' ? TRIM_TO_LEN_TOOL : (m.role === 'user' ? TRIM_TO_LEN_USER : TRIM_TO_LEN_ASSISTANT)
		const numCharsWillTrim = m.content.length - trimToLen

		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			m.content = m.content.slice(0, m.content.length - remainingCharsToTrim - '...'.length).trim() + '...'
			break
		}

		remainingCharsToTrim -= numCharsWillTrim
		m.content = m.content.substring(0, trimToLen - '...'.length) + '...'
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = c.text || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) return null
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IContextGatheringService private readonly contextGatheringService: IContextGatheringService,
	) {
		super()
	}

	// Read .voidrules files from workspace folders
	private _getVoidRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let voidRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.voidrules')
				const { model } = this.voidModelService.getModel(uri)
				if (!model) continue
				voidRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return voidRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .voidrules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)
		return ans.join('\n\n')
	}


	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, semanticSnippets: string[] = [], gatheredContext: string = '') => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		// Fetch git info
		let gitInfo = { branch: '', status: '' }
		try {
			const { resPromise: branchPromise } = await this.terminalToolService.runCommand('git branch --show-current', { type: 'temporary', cwd: null, terminalId: 'git-info-branch' })
			const { resPromise: statusPromise } = await this.terminalToolService.runCommand('git status --short', { type: 'temporary', cwd: null, terminalId: 'git-info-status' })

			const [branchRes, statusRes] = await Promise.all([branchPromise, statusPromise])
			gitInfo.branch = branchRes.result.replace(/^\$ git branch --show-current\n/, '').trim()
			gitInfo.status = statusRes.result.replace(/^\$ git status --short\n/, '').trim()
		} catch (e) {
			console.warn('[Void] Failed to fetch git info for system message:', e)
		}

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'gather' || chatMode === 'plan' ?
				`...Directories string cut off, use tools to read more...`
				: `...Directories string cut off, ask user for more if necessary...`
		})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()
		console.log(`[Void][Diagnostic] getMCPTools returned ${mcpTools?.length ?? 0} tools`);
		if (mcpTools) {
			console.log(`[Void][Diagnostic] MCP Tool names: ${mcpTools.map(t => t.name).join(', ')}`);
		}

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, semanticSnippets, gatheredContext, chatMode, mcpTools, includeXMLToolDefinitions, gitBranch: gitInfo.branch, gitStatus: gitInfo.status })
		return systemMessage
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[]): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
				})
			}
		}
		return simpleLLMMessages
	}

	private _buildPlanTaskJournalContext(chatMessages: ChatMessage[]): string {
		const assistantMessages = chatMessages.filter(m => m.role === 'assistant')
		const journalLines: string[] = []
		for (const message of assistantMessages) {
			const summary = extractTagBlock(message.displayContent, 'task_summary')
			if (!summary) continue
			const taskId = extractTagBlock(summary, 'task_id') ?? `task-${journalLines.length + 1}`
			const taskName = extractTagBlock(summary, 'task_name') ?? 'Untitled task'
			const status = extractTagBlock(summary, 'status') ?? 'completed'
			const shortSummary = extractTagBlock(summary, 'summary') ?? extractTagBlock(summary, 'what') ?? ''
			const shortExplanation = extractTagBlock(summary, 'explanation') ?? extractTagBlock(summary, 'why') ?? ''
			const files = (extractTagBlock(summary, 'files') ?? '')
				.split('\n')
				.map(line => line.replace(/^[-*\s`]+/, '').replace(/[`]/g, '').trim())
				.filter(Boolean)
			const snippetCount = (summary.match(/```[\s\S]*?```/g) ?? []).length
			const filesStr = files.length === 0 ? '(none listed)' : files.join(', ')
			journalLines.push(`- ${taskId}: ${taskName} [${status}] | summary: ${shortSummary || '(not provided)'} | explanation: ${shortExplanation || '(not provided)'} | snippets: ${snippetCount} | files: ${filesStr}`)
		}
		if (journalLines.length === 0) return ''
		return `PLAN TASK JOURNAL (indexed for targeted edits and follow-up):\n${journalLines.join('\n')}`
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings;

		const lastUserMessage = [...chatMessages].reverse().find(m => m.role === 'user');
		let semanticSnippets: string[] = [];
		let gatheredContext = '';
		const semanticStart = Date.now();
		if (lastUserMessage && typeof lastUserMessage.content === 'string') {
			console.log(`[Void][prepareLLMChatMessages] starting semantic snippets lookup (mode=${chatMode}) for message length=${lastUserMessage.content.length}`);
			semanticSnippets = await this.contextGatheringService.getSemanticSnippets(lastUserMessage.content);
			if (chatMode === 'agent' || chatMode === 'gather' || chatMode === 'plan') {
				const contextStart = Date.now();
				const context = await this.contextGatheringService.gatherContext(lastUserMessage.content);
				gatheredContext = formatGatheredContextForPrompt(context);
				const contextSummary = summarizeGatheredContextForLog(context);
				console.log(`[Void][prepareLLMChatMessages] deterministic context ready in ${Date.now() - contextStart}ms (files=${context.relevantFiles.length}, promptChars=${gatheredContext.length}, top=${contextSummary}, mode=${chatMode})`);
			}
		}
		console.log(`[Void][prepareLLMChatMessages] semantic snippets ready in ${Date.now() - semanticStart}ms (count=${semanticSnippets.length}, mode=${chatMode})`);

		const systemMessageStart = Date.now();
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, semanticSnippets, gatheredContext)
		console.log(`[Void][prepareLLMChatMessages] system message built in ${Date.now() - systemMessageStart}ms (mode=${chatMode}, semanticSnippets=${semanticSnippets.length})`);
		const planJournalContext = chatMode === 'plan' ? this._buildPlanTaskJournalContext(chatMessages) : ''
		const systemMessage = disableSystemMessage ? '' : [fullSystemMessage, planJournalContext].filter(Boolean).join('\n\n');

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		console.log(`[Void][prepareLLMChatMessages] prepared ${messages.length} LLM messages (mode=${chatMode}, separateSystemMessage=${!!separateSystemMessage})`);
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/
