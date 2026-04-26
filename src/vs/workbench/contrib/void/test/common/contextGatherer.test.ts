/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extractContextTerms, extractSearchCodebaseTerms, formatGatheredContextForPrompt, gatherContextFromInputs, rankSearchCodebaseCandidates, shouldIncludeContextPath, summarizeGatheredContextForLog } from '../../common/contextGathering/contextGatherer.js';

suite('Void context gatherer', () => {
	test('extracts useful terms from natural language and identifiers', () => {
		assert.deepStrictEqual(
			extractContextTerms('Where is verifyJWT_token expiry handled in auth.ts?'),
			['verifyjwt_token', 'verify', 'jwt', 'token', 'expiry', 'handled', 'auth.ts', 'auth'],
		);
	});

	test('search_codebase terms preserve real identifiers and avoid synthetic joins', () => {
		assert.deepStrictEqual(
			extractSearchCodebaseTerms('who calls sendLLMMessage'),
			['sendllmmessage', 'send', 'llm', 'message'],
		);
		assert.deepStrictEqual(
			extractSearchCodebaseTerms('where is search_codebase implemented'),
			['search_codebase', 'search', 'codebase'],
		);
	});

	test('filters generated, vendor, hidden, and binary paths', () => {
		assert.strictEqual(shouldIncludeContextPath('src/auth.ts'), true);
		assert.strictEqual(shouldIncludeContextPath('node_modules/pkg/index.ts'), false);
		assert.strictEqual(shouldIncludeContextPath('src/build/output.ts'), false);
		assert.strictEqual(shouldIncludeContextPath('.git/config'), false);
		assert.strictEqual(shouldIncludeContextPath('assets/logo.png'), false);
	});

	test('ranks by pathname, search hits, content, and symbols', () => {
		const context = gatherContextFromInputs('Where are built-in tools validated and executed?', [
			{
				path: 'src/vs/workbench/contrib/void/browser/toolsService.ts',
				searchHitCount: 4,
				content: 'validateParams callTool built-in tools executed',
				symbols: [{ name: 'ToolsService', kind: 'class' }],
			},
			{
				path: 'src/vs/workbench/contrib/void/common/toolsServiceTypes.ts',
				searchHitCount: 2,
				content: 'BuiltinToolName BuiltinToolCallParams',
				symbols: [],
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/sidebarActions.ts',
				searchHitCount: 0,
				content: 'sidebar action registration',
				symbols: [],
			},
		]);

		assert.strictEqual(context.relevantFiles[0].path, 'src/vs/workbench/contrib/void/browser/toolsService.ts');
		assert(context.relevantFiles[0].relevanceScore > context.relevantFiles[1].relevanceScore);
		assert.strictEqual(context.relevantFiles[0].content, 'validateParams callTool built-in tools executed');
	});

	test('judgement layer prefers execution and wiring files over registries', () => {
		const sendContext = gatherContextFromInputs('Where is the LLM message sent to providers?', [
			{
				path: 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts',
				searchHitCount: 3,
				content: 'export const sendLLMMessageToProviderImplementation = { anthropic: {}, openai: {} }',
			},
			{
				path: 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts',
				searchHitCount: 2,
				content: 'const implementation = sendLLMMessageToProviderImplementation[providerName]\nimplementation.chat(...)',
			},
		], { maxFullContentFiles: 0 });

		assert.strictEqual(sendContext.relevantFiles[0].path, 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts');

		const promptContext = gatherContextFromInputs('Where is semantic search added to prompts?', [
			{
				path: 'src/vs/workbench/contrib/void/common/prompt/prompts.ts',
				searchHitCount: 4,
				content: 'const semanticInfo = semanticSnippets.length === 0 ? \"\" : \"...\"',
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts',
				searchHitCount: 3,
				content: 'semanticSnippets = await this.contextGatheringService.getSemanticSnippets(lastUserMessage.content)\nconst fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, semanticSnippets, gatheredContext)',
			},
		], { maxFullContentFiles: 0 });

		assert.strictEqual(promptContext.relevantFiles[0].path, 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts');
	});

	test('role classifier prefers core execution over wrappers', () => {
		const context = gatherContextFromInputs('Where is the LLM message sent to providers?', [
			{
				path: 'src/vs/workbench/contrib/void/electron-main/sendLLMMessageChannel.ts',
				searchHitCount: 4,
				content: 'import { sendLLMMessage } from \'./llmMessage/sendLLMMessage.js\'; const p = sendLLMMessage(mainThreadParams, this.metricsService); this.llmMessageEmitters.onText.fire({ requestId, ...p });',
			},
			{
				path: 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts',
				searchHitCount: 3,
				content: 'import { sendLLMMessageToProviderImplementation } from \'./sendLLMMessage.impl.js\'; const implementation = sendLLMMessageToProviderImplementation[providerName]; await sendChat({ messages: messages_ });',
			},
		], { maxFullContentFiles: 0 });

		assert.strictEqual(context.relevantFiles[0].path, 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts');
	});

	test('role classifier prefers prompt assembly over prompt templates', () => {
		const context = gatherContextFromInputs('Where is semantic search added to prompts?', [
			{
				path: 'src/vs/workbench/contrib/void/common/prompt/prompts.ts',
				searchHitCount: 4,
				content: 'const semanticInfo = (semanticSnippets.length === 0 ? \"\" : `Here are some semantically relevant snippets`); const gatheredContextInfo = (!gatheredContext ? \"\" : `<workspace_context>`);',
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts',
				searchHitCount: 3,
				content: 'semanticSnippets = await this.contextGatheringService.getSemanticSnippets(lastUserMessage.content); gatheredContext = formatGatheredContextForPrompt(context); const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, semanticSnippets, gatheredContext);',
			},
		], { maxFullContentFiles: 0 });

		assert.strictEqual(context.relevantFiles[0].path, 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts');
	});

	test('ownership heuristics prefer tool owner over orchestrator loop', () => {
		const context = gatherContextFromInputs('Where are built-in tools validated and executed?', [
			{
				path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts',
				searchHitCount: 6,
				content: 'const isBuiltInTool = isABuiltinToolName(toolName); const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams); const { result } = await this._toolsService.callTool[toolName](toolParams as any);',
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/toolsService.ts',
				searchHitCount: 4,
				content: 'type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }; this.validateParams = { read_file: p => p as any }; this.callTool = { read_file: async p => ({ result: p }) };',
			},
		], { maxFullContentFiles: 0 });

		assert.strictEqual(context.relevantFiles[0].path, 'src/vs/workbench/contrib/void/browser/toolsService.ts');
	});

	test('ownership heuristics prefer prompt assembly owner over template and source files', () => {
		const context = gatherContextFromInputs('Where is semantic search added to prompts?', [
			{
				path: 'src/vs/workbench/contrib/void/common/prompt/prompts.ts',
				searchHitCount: 6,
				content: 'export const chat_systemMessage = ({ semanticSnippets, gatheredContext }) => { const semanticInfo = semanticSnippets.length === 0 ? \"\" : \"semantically relevant snippets\"; const gatheredContextInfo = !gatheredContext ? \"\" : `<workspace_context>`; return semanticInfo + gatheredContextInfo; };',
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/contextGatheringService.ts',
				searchHitCount: 5,
				content: 'public async getSemanticSnippets(query: string): Promise<string[]> { return []; } public async gatherContext(task: string): Promise<any> { return gatherContextFromInputs(task, []); }',
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts',
				searchHitCount: 4,
				content: 'prepareLLMChatMessages = async () => { const semanticSnippets = await this.contextGatheringService.getSemanticSnippets(lastUserMessage.content); const context = await this.contextGatheringService.gatherContext(lastUserMessage.content); const gatheredContext = formatGatheredContextForPrompt(context); const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, semanticSnippets, gatheredContext); return chat_systemMessage({ semanticSnippets, gatheredContext }); };',
			},
		], { maxFullContentFiles: 0 });

		assert.strictEqual(context.relevantFiles[0].path, 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts');
	});

	test('summarizes top gathered files for prompt-boundary diagnostics', () => {
		const context = gatherContextFromInputs('Where are built-in tools validated and executed?', [
			{ path: 'src/vs/workbench/contrib/void/browser/toolsService.ts', searchHitCount: 4, content: 'this.validateParams = {}; this.callTool = {};' },
			{ path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts', searchHitCount: 6, content: 'this._toolsService.validateParams[toolName](opts.unvalidatedToolParams); await this._toolsService.callTool[toolName](toolParams as any);' },
		], { maxFullContentFiles: 0 });

		assert.match(summarizeGatheredContextForLog(context, 1), /^src\/vs\/workbench\/contrib\/void\/browser\/toolsService\.ts \(\d+\)$/);
	});

	test('formats gathered context for prompt injection with the owned top file first', () => {
		const context = gatherContextFromInputs('Where is semantic search added to prompts?', [
			{
				path: 'src/vs/workbench/contrib/void/common/prompt/prompts.ts',
				searchHitCount: 6,
				content: 'export const chat_systemMessage = ({ semanticSnippets, gatheredContext }) => { const semanticInfo = semanticSnippets.length === 0 ? \"\" : \"semantically relevant snippets\"; const gatheredContextInfo = !gatheredContext ? \"\" : `<workspace_context>`; return semanticInfo + gatheredContextInfo; };',
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts',
				searchHitCount: 4,
				content: 'prepareLLMChatMessages = async () => { const semanticSnippets = await this.contextGatheringService.getSemanticSnippets(lastUserMessage.content); const context = await this.contextGatheringService.gatherContext(lastUserMessage.content); const gatheredContext = formatGatheredContextForPrompt(context); const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, semanticSnippets, gatheredContext); return chat_systemMessage({ semanticSnippets, gatheredContext }); };',
			},
		], { maxRelevantFiles: 2, maxFullContentFiles: 0 });

		const gatheredContext = formatGatheredContextForPrompt(context);
		assert.match(gatheredContext, /Relevant files:[\s\S]*convertToLLMMessageService\.ts/);
		assert(gatheredContext.includes('Task terms: semantic, search, added, prompts'));
	});

	test('caps full file content to top files and truncates long content', () => {
		const longContent = 'token '.repeat(200);
		const context = gatherContextFromInputs('token handling', [
			{ path: 'src/one.ts', searchHitCount: 5, content: longContent },
			{ path: 'src/two.ts', searchHitCount: 4, content: 'token token' },
			{ path: 'src/three.ts', searchHitCount: 3, content: 'token' },
		], {
			maxFullContentFiles: 2,
			maxContentChars: 20,
		});

		assert.strictEqual(context.relevantFiles.length, 3);
		assert.strictEqual(context.relevantFiles[0].content, longContent.slice(0, 20));
		assert.strictEqual(context.relevantFiles[0].contentTruncated, true);
		assert.strictEqual(context.relevantFiles[1].content, 'token token');
		assert.strictEqual(context.relevantFiles[2].content, undefined);
	});

	test('returns an empty relevant file list when there are no matches', () => {
		const context = gatherContextFromInputs('jwt expiry', [
			{ path: 'src/readme.md', content: 'unrelated prose' },
		]);

		assert.deepStrictEqual(context.relevantFiles, []);
		assert.deepStrictEqual(context.fileTree, ['src/readme.md']);
	});

	test('search_codebase lexical ranking prefers direct symbol owners over hub files', () => {
		const candidates = rankSearchCodebaseCandidates('who calls sendLLMMessage', [
			{
				path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts',
				content: 'this._llmMessageService.sendLLMMessage({ messagesType: "chatMessages" })',
				symbols: [{ name: 'ChatThreadService', kind: 'class' }],
				importedByCount: 14,
				importCount: 12,
			},
			{
				path: 'src/vs/workbench/contrib/void/common/modelCapabilities.ts',
				content: 'export const defaultProviderSettings = {}',
				symbols: [{ name: 'defaultProviderSettings', kind: 'const' }],
				importedByCount: 12,
				importCount: 1,
			},
		], { searchType: 'callers', maxCandidates: 2 });

		assert.strictEqual(candidates[0].path, 'src/vs/workbench/contrib/void/browser/chatThreadService.ts');
		assert(candidates[0].ripgrepScore > candidates[1].ripgrepScore);
	});

	test('search_codebase caller ranking penalizes definition files and prefers call sites', () => {
		const candidates = rankSearchCodebaseCandidates('who calls sendLLMMessage', [
			{
				path: 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts',
				content: 'export async function sendLLMMessage(params: SendLLMMessageParams) { return sendChat(params); }',
				symbols: [{ name: 'sendLLMMessage', kind: 'function' }],
				importedByCount: 8,
				importCount: 4,
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts',
				content: 'this._llmMessageService.sendLLMMessage({ messagesType: "chatMessages" });',
				symbols: [{ name: 'ChatThreadService', kind: 'class' }],
				importedByCount: 14,
				importCount: 12,
			},
		], { searchType: 'callers', maxCandidates: 2 });

		assert.strictEqual(candidates[0].path, 'src/vs/workbench/contrib/void/browser/chatThreadService.ts');
		assert(candidates[0].structuralScore > candidates[1].structuralScore);
	});

	test('search_codebase caller ranking penalizes tests and basename-only matches', () => {
		const candidates = rankSearchCodebaseCandidates('who calls sendLLMMessage', [
			{
				path: 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts',
				content: 'export async function sendLLMMessage(params: SendLLMMessageParams) { return sendChat(params); }',
				symbols: [{ name: 'sendLLMMessage', kind: 'function' }],
				importedByCount: 8,
				importCount: 4,
			},
			{
				path: 'src/vs/workbench/contrib/void/test/common/contextGatherer.test.ts',
				content: 'assert.strictEqual(sendLLMMessage, sendLLMMessage)',
				symbols: [{ name: 'contextGatherer', kind: 'suite' }],
				importedByCount: 0,
				importCount: 1,
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts',
				content: 'this._llmMessageService.sendLLMMessage({ messagesType: "chatMessages" });',
				symbols: [{ name: 'ChatThreadService', kind: 'class' }],
				importedByCount: 14,
				importCount: 12,
			},
		], { searchType: 'callers', maxCandidates: 3 });

		assert.strictEqual(candidates[0].path, 'src/vs/workbench/contrib/void/browser/chatThreadService.ts');
		assert.strictEqual(candidates[2].path, 'src/vs/workbench/contrib/void/test/common/contextGatherer.test.ts');
	});

	test('search_codebase caller ranking strongly prefers indexed caller hits', () => {
		const candidates = rankSearchCodebaseCandidates('who calls sendLLMMessage', [
			{
				path: 'src/vs/workbench/contrib/void/common/sendLLMMessageService.ts',
				content: 'sendLLMMessage(params: ServiceSendLLMMessageParams) { this.channel.call("sendLLMMessage", params); }',
				symbols: [{ name: 'sendLLMMessage', kind: 'method' }],
				searchHitCount: 4,
				callerHitCount: 1,
				importedByCount: 12,
				importCount: 4,
			},
			{
				path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts',
				content: 'this._llmMessageService.sendLLMMessage({ messagesType: "chatMessages" }); this._llmMessageService.sendLLMMessage({ messagesType: "chatMessages" });',
				symbols: [{ name: 'ChatThreadService', kind: 'class' }],
				searchHitCount: 3,
				callerHitCount: 2,
				importedByCount: 14,
				importCount: 12,
			},
		], { searchType: 'callers', maxCandidates: 2 });

		assert.strictEqual(candidates[0].path, 'src/vs/workbench/contrib/void/browser/chatThreadService.ts');
		assert(candidates[0].totalScore > candidates[1].totalScore);
	});

	test('search_codebase preview prefers hierarchical neighborhood summaries when present', () => {
		const candidates = rankSearchCodebaseCandidates('who calls sendLLMMessage', [
			{
				path: 'src/vs/workbench/contrib/void/browser/chatThreadService.ts',
				contextSummary: 'Context neighborhood score: 88\nAnchors: sendLLMMessage [call]\nEdges: calls:sendLLMMessage',
				content: 'this._llmMessageService.sendLLMMessage({ messagesType: "chatMessages" });',
				graphHitCount: 8,
				callerHitCount: 2,
				symbols: [{ name: 'ChatThreadService', kind: 'class' }],
			},
		], { searchType: 'callers', maxCandidates: 1 });

		assert.match(candidates[0].contentPreview, /Context neighborhood score: 88/);
		assert.match(candidates[0].contentPreview, /Anchors: sendLLMMessage \[call\]/);
	});

	test('search_codebase lexical ranking finds exact tool identifier files', () => {
		const candidates = rankSearchCodebaseCandidates('where is search_codebase implemented', [
			{
				path: 'src/vs/workbench/contrib/void/common/contextGathering/searchCodebaseTool.ts',
				content: 'export const searchCodebaseToolInfo = { name: "search_codebase" }; export const runSearchCodebase = async () => {};',
				symbols: [{ name: 'runSearchCodebase', kind: 'function' }],
				importedByCount: 1,
				importCount: 2,
			},
			{
				path: 'src/vs/workbench/contrib/void/common/prompt/prompts.ts',
				content: 'import { searchCodebaseToolInfo } from "../contextGathering/searchCodebaseTool.js";',
				symbols: [{ name: 'builtinTools', kind: 'const' }],
				importedByCount: 20,
				importCount: 10,
			},
		], { searchType: 'definition', maxCandidates: 2 });

		assert.strictEqual(candidates[0].path, 'src/vs/workbench/contrib/void/common/contextGathering/searchCodebaseTool.ts');
	});

	test('search_codebase definition ranking prefers declaration over prompt helpers', () => {
		const candidates = rankSearchCodebaseCandidates('where is search_codebase implemented', [
			{
				path: 'src/vs/workbench/contrib/void/common/contextGathering/searchCodebaseTool.ts',
				content: 'export const searchCodebaseToolInfo = { name: "search_codebase" }; export const runSearchCodebase = async () => {};',
				symbols: [{ name: 'runSearchCodebase', kind: 'function' }],
				importedByCount: 1,
				importCount: 2,
			},
			{
				path: 'src/vs/workbench/contrib/void/common/contextGathering/searchCodebasePromptService.ts',
				content: 'export const buildSearchCodebaseRerankerPrompt = () => ({})',
				symbols: [{ name: 'buildSearchCodebaseRerankerPrompt', kind: 'function' }],
				importedByCount: 1,
				importCount: 1,
			},
		], { searchType: 'definition', maxCandidates: 2 });

		assert.strictEqual(candidates[0].path, 'src/vs/workbench/contrib/void/common/contextGathering/searchCodebaseTool.ts');
		assert(candidates[0].structuralScore > candidates[1].structuralScore);
	});
});
