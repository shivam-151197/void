/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { SearchCodebaseCandidate, SearchCodebaseSearchType } from './contextGatherer.js';
import { buildSearchCodebaseExpansionPrompt, buildSearchCodebaseRerankerPrompt } from './searchCodebasePromptService.js';

export type SearchCodebaseParams = {
	query: string;
	searchType: SearchCodebaseSearchType;
};

export type SearchCodebaseResultFile = {
	path: string;
	fullPath: string;
	relevance: 'high' | 'medium' | 'low';
	reason: string;
	symbols: string[];
	preview: string;
};

export type SearchCodebaseResult = {
	files: SearchCodebaseResultFile[];
	search_summary: string;
	grounding_rules: string;
	suggested_next: string;
	error?: string;
};

type RankedCandidate = {
	path: string;
	relevance: 'high' | 'medium' | 'low';
	reason: string;
};

type RerankerResponse = {
	ranked?: RankedCandidate[];
	suggested_next?: string;
};

export const searchCodebaseToolInfo = {
	name: 'search_codebase',
	description: 'Search the codebase for files related to a concept, behavior, symbol, or ownership question. Call this when you need to find where something is implemented, defined, or called.',
	params: {
		query: {
			description: "Natural language description of what you are looking for. Be specific. Examples: 'where is JWT token verified', 'function that sends LLM requests to providers', 'where are keyboard shortcuts registered'"
		},
		search_type: {
			description: 'The search mode. Use ownership to find the source-of-truth file, references to find usage sites, definition to find declarations, or callers to find who invokes a function.'
		},
	}
} as const;

const trimPreview = (preview: string): string => preview.trim().split('\n').slice(0, 20).join('\n').trim();

const buildPreview = (candidate: SearchCodebaseCandidate): string => {
	if (candidate.evidenceSnippets?.length) {
		return candidate.evidenceSnippets
			.slice(0, 3)
			.map(s => `[lines ${s.startLine}-${s.endLine}]\n${s.text.trim()}`)
			.join('\n...\n');
	}
	return trimPreview(candidate.contentPreview);
};

const buildFallbackReason = (candidate: SearchCodebaseCandidate): string => {
	const reasons: string[] = [];
	if ((candidate.searchHitCount ?? 0) > 0) {
		reasons.push(`matched ${candidate.searchHitCount} text hit${candidate.searchHitCount === 1 ? '' : 's'}`);
	}
	if (candidate.symbols?.length) {
		reasons.push(`contains ${candidate.symbols.length} symbol${candidate.symbols.length === 1 ? '' : 's'}`);
	}
	if (candidate.importedByCount && candidate.importedByCount > 0) {
		reasons.push(`is referenced by ${candidate.importedByCount} file${candidate.importedByCount === 1 ? '' : 's'}`);
	}
	if (reasons.length === 0) {
		return 'Ranked highly by static search signals.';
	}
	return `${reasons[0][0].toUpperCase()}${reasons[0].slice(1)}${reasons.length > 1 ? ` and ${reasons[1]}` : ''}.`;
};

const fallbackRelevance = (index: number): 'high' | 'medium' | 'low' => {
	if (index < 2) return 'high';
	if (index < 4) return 'medium';
	return 'low';
};

const buildFallbackResult = (
	params: SearchCodebaseParams,
	candidates: SearchCodebaseCandidate[],
	error?: string,
): SearchCodebaseResult => {
	const files = candidates.slice(0, 5).map((candidate, index) => ({
		path: candidate.path,
		fullPath: candidate.uri ? URI.parse(candidate.uri).fsPath : candidate.path,
		relevance: fallbackRelevance(index),
		reason: buildFallbackReason(candidate),
		symbols: candidate.symbols?.map(symbol => symbol.name).slice(0, 12) ?? [],
		preview: trimPreview(candidate.contentPreview),
	}));

	return {
		files,
		search_summary: `Searched "${params.query}" across candidate files, reranked ${candidates.length}, and returned the top ${files.length}.`,
		grounding_rules: '',
		suggested_next: candidates[0]?.symbols?.[0]
			? `If these are insufficient, search for references or callers of ${candidates[0].symbols[0].name}.`
			: `If these are insufficient, try a narrower ${params.searchType === 'ownership' ? 'definition' : 'ownership'} search with a more specific symbol or filename.`,
		...(error ? { error } : {}),
	};
};

const parseRerankerResponse = (responseText: string): RerankerResponse | null => {
	try {
		const firstBrace = responseText.indexOf('{');
		const lastBrace = responseText.lastIndexOf('}');
		if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
			return null;
		}
		const parsed = JSON.parse(responseText.slice(firstBrace, lastBrace + 1)) as RerankerResponse;
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
};

export const runSearchCodebase = async (
	params: SearchCodebaseParams,
	deps: {
		expandQuery: (messages: { systemPrompt: string; userPrompt: string }) => Promise<string | null>;
		getCandidates: (params: SearchCodebaseParams & { extraTerms?: string[] }) => Promise<SearchCodebaseCandidate[]>;
		rerankCandidates: (messages: { systemPrompt: string; userPrompt: string }) => Promise<string | null>;
	},
): Promise<SearchCodebaseResult> => {
	try {
		const expansionMessages = buildSearchCodebaseExpansionPrompt(params);
		const expandedResult = await deps.expandQuery(expansionMessages);
		const extraTerms = expandedResult ? expandedResult.split(',').map(t => t.trim()).filter(Boolean) : [];

		const candidates = (await deps.getCandidates({ ...params, extraTerms })).slice(0, 12); // Slightly larger pool for expansion
		if (candidates.length === 0) {
			return {
				files: [],
				search_summary: `Searched "${params.query}" but found no viable candidates.`,
				grounding_rules: '',
				suggested_next: 'Try a more specific symbol name, filename fragment, or narrower search type.',
			};
		}

		const rerankerMessages = buildSearchCodebaseRerankerPrompt(params, candidates);
		const rerankerResponse = await deps.rerankCandidates(rerankerMessages);
		if (!rerankerResponse) {
			return buildFallbackResult(params, candidates, 'LLM reranker unavailable, returned static ranking.');
		}

		const parsed = parseRerankerResponse(rerankerResponse);
		if (!parsed?.ranked?.length) {
			return buildFallbackResult(params, candidates, 'LLM reranker returned invalid JSON, returned static ranking.');
		}

		const candidateByPath = new Map(candidates.map(candidate => [candidate.path, candidate] as const));
		const files = parsed.ranked
			.slice(0, 8)
			.map(item => {
				const candidate = candidateByPath.get(item.path);
				if (!candidate) {
					return null;
				}
				return {
					path: candidate.path,
					fullPath: candidate.uri ? URI.parse(candidate.uri).fsPath : candidate.path,
					relevance: item.relevance,
					reason: item.reason,
					symbols: candidate.symbols?.map(symbol => symbol.name).slice(0, 15) ?? [],
					preview: buildPreview(candidate),
				} satisfies SearchCodebaseResultFile;
			})
			.filter((item): item is SearchCodebaseResultFile => item !== null);

		if (files.length === 0) {
			return buildFallbackResult(params, candidates, 'LLM reranker returned unknown paths, returned static ranking.');
		}

		const hasHighRelevance = files.some(f => f.relevance === 'high');
		const groundingRules = `\n\n[[[ STRICT GROUNDING RULES ]]]\n1. EXCLUSIVELY use the files and code snippets listed above.\n2. DO NOT assume the existence of any file or directory not explicitly shown in these results.\n3. Cite symbols and Evidence from the snippets when answering.${hasHighRelevance ? '\n4. If these results are sufficient, STOP and answer the user query now.' : '\n4. If these results are NOT sufficient, you MUST call another discovery tool (e.g. read_file, search_for_files) to proceed.'}`;

		return {
			files,
			search_summary: `Searched "${params.query}" across candidate files, reranked ${candidates.length}, and returned the top ${files.length}.`,
			grounding_rules: groundingRules,
			suggested_next: parsed.suggested_next || (hasHighRelevance ? 'Answer the user query based on the high-relevance results above.' : buildFallbackResult(params, candidates).suggested_next),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			files: [],
			search_summary: `Search failed for "${params.query}".`,
			grounding_rules: '',
			suggested_next: 'Retry with a simpler query or a different search type.',
			error: message,
		};
	}
};
