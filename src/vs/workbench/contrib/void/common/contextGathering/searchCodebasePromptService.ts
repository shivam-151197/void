/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { SearchCodebaseCandidate } from './contextGatherer.js';
import { SearchCodebaseParams } from './searchCodebaseTool.js';

export type SearchCodebaseRerankerPrompt = {
	systemPrompt: string;
	userPrompt: string;
};

export type SearchCodebaseExpansionPrompt = {
	systemPrompt: string;
	userPrompt: string;
};

const rerankerSystemPrompt = `Code Ownership Analyst.
Rules:
1. MASTER OVER SLAVE: Prioritize implementations/registrations over consumers.
2. DEFINITION OVER USAGE: Prioritize declarations over imports.
3. FUNCTIONAL EVIDENCE: Prioritize actionable symbols (registry.register, service.auth) over comments/tests.
4. NO HALLUCINATIONS: Use ONLY provided symbols/evidence. Do not assume project structure.
5. CITATION: Cite specific symbols in 'reason'.
Return ONLY JSON.`;

const expansionSystemPrompt = `Code Search Query Expander.
Role: Expand a natural language query into 5-8 technical keywords likely to appear in source code (filenames, symbols, terms).
Rules:
1. No generalities (implementation, code, function).
2. Use technical synonyms (auth -> login, jwt, token, identity).
3. Use common abbreviations (callback -> cb, configuration -> config).
4. Predict symbols (service, router, controller).
Return ONLY a comma-separated list of keywords.`;

const trimPreview = (preview: string): string => preview.trim().split('\n').slice(0, 20).join('\n').trim();

export const buildSearchCodebaseRerankerPrompt = (
	params: SearchCodebaseParams,
	candidates: SearchCodebaseCandidate[],
): SearchCodebaseRerankerPrompt => {
	const renderedCandidates = candidates.map(candidate => {
		const symbols = candidate.symbols?.map(symbol => symbol.name).slice(0, 12).join(', ') || '(none)';
		const evidence = candidate.evidenceSnippets?.length
			? candidate.evidenceSnippets.slice(0, 4).map(snippet => `[lines ${snippet.startLine}-${snippet.endLine}]
${snippet.text}`).join('\n...\n')
			: trimPreview(candidate.contentPreview).split('\n').slice(0, 10).join('\n');
		const stats = [
			`searchHits=${candidate.searchHitCount ?? 0}`,
			`callerHits=${candidate.callerHitCount ?? 0}`,
			`graphHits=${candidate.graphHitCount ?? 0}`,
			`importedBy=${candidate.importedByCount ?? 0}`,
		].join(', ');
		return `Path: ${candidate.path}
Symbols: ${symbols}
Signals: ${stats}
Evidence:
\`\`\`
${evidence}
\`\`\``;
	}).join('\n\n');

	return {
		systemPrompt: rerankerSystemPrompt,
		userPrompt: `Task: ${params.query}
Search type: ${params.searchType}

Candidates:
${renderedCandidates}

Return this exact JSON:
{
  "ranked": [
    {
      "path": "relative/path",
      "relevance": "high|medium|low",
      "reason": "one sentence why"
    }
  ],
  "suggested_next": "Optional (one sentence): only if these results are insufficient"
}

Return at most 8 items. Do not include any text outside the JSON object.`,
	};
};

export const buildSearchCodebaseExpansionPrompt = (
	params: SearchCodebaseParams,
): SearchCodebaseExpansionPrompt => {
	return {
		systemPrompt: expansionSystemPrompt,
		userPrompt: `Query: ${params.query}
Keywords:`,
	};
};
