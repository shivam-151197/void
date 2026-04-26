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

const rerankerSystemPrompt = `You are a code ownership analyzer. Your only job is to rank files by how likely
they are to be the source of truth for the given task.

Rules:
- Return ONLY valid JSON. No explanation before or after.
- Rank by ownership probability, not by keyword frequency.
- A file that IMPLEMENTS behavior ranks higher than a file that CALLS it.
- A file that DEFINES a type ranks higher than a file that USES the type.
- Consider the search_type: for "ownership" prefer implementation files;
  for "callers" prefer files that import/use the symbol; for "definition"
  prefer files where the symbol is first declared.`;

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
  "suggested_next": "one sentence: what to search for if these are wrong"
}

Return at most 6 items. Do not include any text outside the JSON object.`,
	};
};
