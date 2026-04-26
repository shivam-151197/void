/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { SearchCodebaseCandidate, SearchCodebaseSearchType } from './contextGatherer.js';
import { buildSearchCodebaseRerankerPrompt } from './searchCodebasePromptService.js';

export type SearchCodebaseParams = {
	query: string;
	searchType: SearchCodebaseSearchType;
};

export type SearchCodebaseResultFile = {
	path: string;
	relevance: 'high' | 'medium' | 'low';
	reason: string;
	symbols: string[];
	preview: string;
};

export type SearchCodebaseResult = {
	files: SearchCodebaseResultFile[];
	search_summary: string;
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

const trimPreview = (preview: string): string => preview.trim().split('\n').slice(0, 8).join('\n').trim();

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
		relevance: fallbackRelevance(index),
		reason: buildFallbackReason(candidate),
		symbols: candidate.symbols?.map(symbol => symbol.name).slice(0, 12) ?? [],
		preview: trimPreview(candidate.contentPreview),
	}));

	return {
		files,
		search_summary: `Searched "${params.query}" across candidate files, reranked ${candidates.length}, and returned the top ${files.length}.`,
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
		getCandidates: (params: SearchCodebaseParams) => Promise<SearchCodebaseCandidate[]>;
		rerankCandidates: (messages: { systemPrompt: string; userPrompt: string }) => Promise<string | null>;
	},
): Promise<SearchCodebaseResult> => {
	try {
		const candidates = (await deps.getCandidates(params)).slice(0, 8);
		if (candidates.length === 0) {
			return {
				files: [],
				search_summary: `Searched "${params.query}" but found no viable candidates.`,
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
			.slice(0, 6)
			.map(item => {
				const candidate = candidateByPath.get(item.path);
				if (!candidate) {
					return null;
				}
				return {
					path: candidate.path,
					relevance: item.relevance,
					reason: item.reason,
					symbols: candidate.symbols?.map(symbol => symbol.name).slice(0, 12) ?? [],
					preview: trimPreview(candidate.contentPreview),
				} satisfies SearchCodebaseResultFile;
			})
			.filter((item): item is SearchCodebaseResultFile => item !== null);

		if (files.length === 0) {
			return buildFallbackResult(params, candidates, 'LLM reranker returned unknown paths, returned static ranking.');
		}

		return {
			files,
			search_summary: `Searched "${params.query}" across candidate files, reranked ${candidates.length}, and returned the top ${files.length}.`,
			suggested_next: parsed.suggested_next ?? buildFallbackResult(params, candidates).suggested_next,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			files: [],
			search_summary: `Search failed for "${params.query}".`,
			suggested_next: 'Retry with a simpler query or a different search type.',
			error: message,
		};
	}
};
