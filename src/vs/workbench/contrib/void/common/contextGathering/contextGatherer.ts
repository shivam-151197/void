/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export interface GatherContextSymbol {
	name: string;
	kind: string;
	range?: {
		startLine: number;
		endLine: number;
	};
}

export interface GatherContextFileInput {
	path: string;
	content?: string | null;
	contextSummary?: string | null;
	symbols?: GatherContextSymbol[];
	searchHitCount?: number;
	graphHitCount?: number;
	callerHitCount?: number;
	importCount?: number;
	importedByCount?: number;
	modifiedTimeMs?: number;
	lineCount?: number;
}

export interface GatheredContextFile {
	path: string;
	relevanceScore: number;
	searchHitCount: number;
	symbols: GatherContextSymbol[];
	content?: string;
	contentTruncated?: boolean;
}

export interface GatheredContext {
	task: string;
	terms: string[];
	fileTree: string[];
	relevantFiles: GatheredContextFile[];
}

export interface GatherContextOptions {
	maxFileTreeEntries?: number;
	maxRelevantFiles?: number;
	maxFullContentFiles?: number;
	maxContentChars?: number;
}

export type SearchCodebaseSearchType = 'ownership' | 'references' | 'definition' | 'callers';

export interface SearchCodebaseEvidenceSnippet {
	startLine: number;
	endLine: number;
	text: string;
}

export interface SearchCodebaseCandidate extends GatherContextFileInput {
	ripgrepScore: number;
	structuralScore: number;
	totalScore: number;
	contentPreview: string;
	evidenceSnippets: SearchCodebaseEvidenceSnippet[];
	lineCount: number;
}

const DEFAULT_OPTIONS: Required<GatherContextOptions> = {
	maxFileTreeEntries: 1000,
	maxRelevantFiles: 8,
	maxFullContentFiles: 3,
	maxContentChars: 20000,
};

const STOP_WORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'code', 'do', 'does', 'file',
	'find', 'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'me', 'of', 'on', 'or',
	'please', 'show', 'tell', 'that', 'the', 'this', 'to', 'where', 'which', 'with', 'you',
	'who',
]);

const SEARCH_CODEBASE_STOP_WORDS = new Set([
	...STOP_WORDS,
	'call',
	'calls',
	'caller',
	'callers',
	'define',
	'defined',
	'defines',
	'definition',
	'function',
	'functions',
	'implemented',
	'implementation',
	'implementations',
	'implements',
	'owner',
	'ownership',
	'reference',
	'references',
]);

const EXCLUDED_SEGMENTS = new Set([
	'.git',
	'.hg',
	'.svn',
	'node_modules',
	'dist',
	'build',
	'out',
	'bin',
	'coverage',
	'__pycache__',
	'env',
	'venv',
	'tmp',
	'temp',
	'artifacts',
	'target',
	'obj',
	'vendor',
	'logs',
	'cache',
	'resource',
	'resources',
]);

const BINARY_EXTENSIONS = new Set([
	'.7z', '.avif', '.bin', '.bmp', '.class', '.db', '.dll', '.dmg', '.exe', '.gif', '.gz',
	'.ico', '.jar', '.jpeg', '.jpg', '.lockb', '.mov', '.mp3', '.mp4', '.o', '.pdf', '.png',
	'.rlib', '.so', '.sqlite', '.tar', '.tgz', '.wasm', '.webp', '.woff', '.woff2', '.zip',
]);

const EXCLUDED_BASENAMES = new Set([
	'void_agent_session.json',
	'implementation_plan.md',
	'implementation_plan.md.resolved',
]);

const LOW_SIGNAL_BASENAME_SUFFIXES = ['types', 'type', 'interfaces', 'interface'];

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\/+/, '');

const stripExtension = (path: string): string => path.replace(/\.[^.\/]+$/, '');

const basenameWithoutExtension = (path: string): string => {
	const normalized = normalizePath(path);
	const basename = normalized.split('/').pop() ?? normalized;
	return stripExtension(basename).toLowerCase();
};

const normalizeWordVariants = (value: string): string[] => {
	const normalized = stripExtension(value).toLowerCase();
	const variants = new Set<string>([normalized]);
	const irregulars: Record<string, string[]> = {
		sent: ['send'],
		built: ['build'],
		bought: ['buy'],
		ran: ['run'],
		wrote: ['write'],
		written: ['write'],
	};

	for (const variant of irregulars[normalized] ?? []) {
		variants.add(variant);
	}

	if (normalized.endsWith('ies') && normalized.length > 4) {
		variants.add(normalized.slice(0, -3) + 'y');
	}
	if (normalized.endsWith('ied') && normalized.length > 4) {
		variants.add(normalized.slice(0, -3) + 'y');
	}
	if (normalized.endsWith('es') && normalized.length > 4) {
		variants.add(normalized.slice(0, -2));
	}
	if (normalized.endsWith('s') && normalized.length > 4) {
		variants.add(normalized.slice(0, -1));
	}
	if (normalized.endsWith('ed') && normalized.length > 4) {
		const root = normalized.slice(0, -2);
		variants.add(root);
		variants.add(root + 'e');
	}
	if (normalized.endsWith('ing') && normalized.length > 5) {
		const root = normalized.slice(0, -3);
		variants.add(root);
		variants.add(root + 'e');
	}

	return [...variants].filter(Boolean);
};

const splitIdentifier = (value: string): string[] => {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_./:-]+/g, ' ')
		.split(/\s+/g)
		.filter(Boolean);
};

const hasAnyTerm = (haystack: string, needles: string[]): boolean => needles.some(needle => haystack.includes(needle));

const getImportSpecifiers = (content: string): string[] => {
	const specifiers = new Set<string>();
	for (const match of content.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
		specifiers.add(match[1]);
	}
	for (const match of content.matchAll(/\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g)) {
		specifiers.add(match[1]);
	}
	for (const match of content.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		specifiers.add(match[1]);
	}
	return [...specifiers];
};

const countExports = (file: GatherContextFileInput): number => {
	const content = file.content ?? '';
	const symbolCount = file.symbols?.length ?? 0;
	const explicitExports = (content.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum|\{)/g) ?? []).length;
	const commonJsExports = (content.match(/\bmodule\.exports\b/g) ?? []).length + (content.match(/\bexports\.[A-Za-z0-9_$]+\b/g) ?? []).length;
	return Math.max(symbolCount, explicitExports + commonJsExports);
};

const resolveImportTarget = (importerPath: string, specifier: string): string | null => {
	if (!specifier.startsWith('.')) {
		return null;
	}

	const importerSegments = normalizePath(importerPath).split('/').filter(Boolean);
	importerSegments.pop();
	for (const part of specifier.split('/')) {
		if (!part || part === '.') {
			continue;
		}
		if (part === '..') {
			importerSegments.pop();
			continue;
		}
		importerSegments.push(part);
	}
	return stripExtension(importerSegments.join('/')).toLowerCase();
};

interface StructuralMetrics {
	exportCount: number;
	importCount: number;
	importedByCount: number;
	basenameExactMatch: boolean;
	modifiedTimeMs?: number;
}

interface StructuralThresholds {
	exportCount?: number;
	importedByCount?: number;
	importCountLow?: number;
	modifiedTimeMs?: number;
}

const topBucketThreshold = (values: number[]): number | undefined => {
	const positives = values.filter(value => value > 0).sort((a, b) => b - a);
	if (positives.length === 0) {
		return undefined;
	}
	return positives[Math.max(0, Math.ceil(positives.length * 0.2) - 1)];
};

const lowBucketThreshold = (values: number[]): number | undefined => {
	const positives = values.filter(value => value > 0).sort((a, b) => a - b);
	if (positives.length === 0) {
		return undefined;
	}
	return positives[Math.max(0, Math.ceil(positives.length * 0.4) - 1)];
};

const firstLines = (content: string, maxLines: number): string => {
	return content.split('\n').slice(0, maxLines).join('\n').trim();
};

const extractEvidenceSnippets = (content: string, terms: string[], maxSnippets: number): SearchCodebaseEvidenceSnippet[] => {
	if (!content) {
		return [];
	}

	const lines = content.split('\n');
	const normalizedTerms = dedupeOrdered(terms.map(term => stripExtension(term).toLowerCase()).filter(term => term.length >= 2));
	if (normalizedTerms.length === 0) {
		return [];
	}

	const seenRanges = new Set<string>();
	const snippets: SearchCodebaseEvidenceSnippet[] = [];

	for (const term of normalizedTerms) {
		const exactRegex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) {
				continue;
			}
			const normalizedLine = line.toLowerCase();
			if (!exactRegex.test(line) && !normalizedLine.includes(term)) {
				continue;
			}

			const start = Math.max(0, i - 1);
			const end = Math.min(lines.length, i + 2);
			const rangeKey = `${start}:${end}`;
			if (seenRanges.has(rangeKey)) {
				continue;
			}
			seenRanges.add(rangeKey);

			const snippetText = lines.slice(start, end).join('\n').trim();
			if (!snippetText) {
				continue;
			}
			snippets.push({
				startLine: start + 1,
				endLine: end,
				text: snippetText,
			});
			if (snippets.length >= maxSnippets) {
				return snippets;
			}
		}
	}

	return snippets;
};

const dedupeOrdered = (values: string[]): string[] => {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) {
			continue;
		}
		seen.add(value);
		result.push(value);
	}
	return result;
};

const countFieldTokens = (value: string): number => (value.match(/[A-Za-z0-9_]+/g) ?? []).length || 1;

const isCodeLikeTerm = (value: string): boolean => /[A-Z_.:/-]/.test(value);

const pushSearchTerm = (bucket: string[], term: string) => {
	const normalized = stripExtension(term).toLowerCase();
	if (normalized.length < 2 || SEARCH_CODEBASE_STOP_WORDS.has(normalized)) {
		return;
	}
	bucket.push(normalized);
};

export const extractSearchCodebaseTerms = (query: string): string[] => {
	const rawTerms = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
	const exactTerms: string[] = [];
	const normalizedTerms: string[] = [];
	const splitTerms: string[] = [];

	for (const rawTerm of rawTerms) {
		const normalizedRawTerm = stripExtension(rawTerm).toLowerCase();
		const isIntentWord = SEARCH_CODEBASE_STOP_WORDS.has(normalizedRawTerm);

		if (isCodeLikeTerm(rawTerm)) {
			pushSearchTerm(exactTerms, rawTerm);
		}

		if (!isIntentWord) {
			for (const variant of normalizeWordVariants(rawTerm)) {
				pushSearchTerm(normalizedTerms, variant);
			}
		}

		for (const part of splitIdentifier(rawTerm)) {
			if (isCodeLikeTerm(rawTerm)) {
				pushSearchTerm(splitTerms, part);
			}
			if (SEARCH_CODEBASE_STOP_WORDS.has(part.toLowerCase())) {
				continue;
			}
			for (const normalized of normalizeWordVariants(part)) {
				pushSearchTerm(splitTerms, normalized);
			}
		}
	}

	const rankedTerms = [
		...dedupeOrdered(exactTerms),
		...dedupeOrdered(normalizedTerms),
		...dedupeOrdered(splitTerms),
	];

	return dedupeOrdered(rankedTerms).slice(0, 8);
};

type SearchCodebaseFieldStats = {
	path: string;
	content: string;
	symbolNames: string[];
	pathLength: number;
	contentLength: number;
	symbolLength: number;
};

type SearchCodebaseLexicalStats = {
	byPath: Map<string, SearchCodebaseFieldStats>;
	pathDf: Map<string, number>;
	contentDf: Map<string, number>;
	symbolDf: Map<string, number>;
	avgPathLength: number;
	avgContentLength: number;
	avgSymbolLength: number;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const extractSearchCodebaseAnchors = (query: string): string[] => {
	const rawTerms = query.match(/[A-Za-z0-9_./:-]+/g) ?? [];
	const anchors: string[] = [];

	for (const rawTerm of rawTerms) {
		if (!isCodeLikeTerm(rawTerm)) {
			continue;
		}

		const normalized = stripExtension(rawTerm).toLowerCase();
		if (normalized.length >= 3) {
			anchors.push(normalized);
		}

		const splitParts = splitIdentifier(rawTerm)
			.map(part => stripExtension(part).toLowerCase())
			.filter(part => part.length >= 2 && !SEARCH_CODEBASE_STOP_WORDS.has(part));

		if (splitParts.length >= 2) {
			anchors.push(splitParts.join(''));
			anchors.push(splitParts.join('_'));
		}
	}

	if (anchors.length === 0) {
		return extractSearchCodebaseTerms(query)
			.filter(term => term.length >= 4)
			.slice(0, 2);
	}

	return dedupeOrdered(anchors);
};

const buildSearchCodebaseLexicalStats = (files: GatherContextFileInput[], terms: string[]): SearchCodebaseLexicalStats => {
	const byPath = new Map<string, SearchCodebaseFieldStats>();
	const pathDf = new Map<string, number>();
	const contentDf = new Map<string, number>();
	const symbolDf = new Map<string, number>();

	let totalPathLength = 0;
	let totalContentLength = 0;
	let totalSymbolLength = 0;

	for (const file of files) {
		const path = normalizePath(file.path).toLowerCase();
		const content = file.content?.toLowerCase() ?? '';
		const symbolNames = (file.symbols ?? []).map(symbol => symbol.name.toLowerCase());
		const pathLength = countFieldTokens(path);
		const contentLength = countFieldTokens(content);
		const symbolLength = Math.max(1, symbolNames.reduce((sum, name) => sum + countFieldTokens(name), 0));

		byPath.set(file.path, { path, content, symbolNames, pathLength, contentLength, symbolLength });
		totalPathLength += pathLength;
		totalContentLength += contentLength;
		totalSymbolLength += symbolLength;

		for (const term of terms) {
			if (path.includes(term)) pathDf.set(term, (pathDf.get(term) ?? 0) + 1);
			if (content.includes(term)) contentDf.set(term, (contentDf.get(term) ?? 0) + 1);
			if (symbolNames.some(name => name.includes(term))) symbolDf.set(term, (symbolDf.get(term) ?? 0) + 1);
		}
	}

	return {
		byPath,
		pathDf,
		contentDf,
		symbolDf,
		avgPathLength: files.length > 0 ? totalPathLength / files.length : 1,
		avgContentLength: files.length > 0 ? totalContentLength / files.length : 1,
		avgSymbolLength: files.length > 0 ? totalSymbolLength / files.length : 1,
	};
};

const bm25Idf = (documentCount: number, documentFrequency: number): number => {
	return Math.log(1 + ((documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5)));
};

const bm25Score = (tf: number, docLength: number, avgDocLength: number, idf: number, opts?: { k1?: number; b?: number }): number => {
	if (tf <= 0) return 0;
	const k1 = opts?.k1 ?? 1.2;
	const b = opts?.b ?? 0.75;
	const lengthNorm = 1 - b + b * (docLength / Math.max(1, avgDocLength));
	return idf * ((tf * (k1 + 1)) / (tf + k1 * lengthNorm));
};

const scoreSearchCodebaseFile = (
	file: GatherContextFileInput,
	terms: string[],
	lexicalStats: SearchCodebaseLexicalStats,
): number => {
	const stats = lexicalStats.byPath.get(file.path);
	if (!stats) return 0;

	const basenameNoExt = basenameWithoutExtension(stats.path);
	const documentCount = lexicalStats.byPath.size;
	let score = Math.max(0, file.searchHitCount ?? 0) * 3;
	score += Math.max(0, file.graphHitCount ?? 0) * 5;
	score += Math.max(0, file.callerHitCount ?? 0) * 18;

	for (const term of terms) {
		const pathTf = countOccurrences(stats.path, term);
		const contentTf = countOccurrences(stats.content, term);
		const symbolExactMatches = stats.symbolNames.filter(name => name === term).length;
		const symbolPartialMatches = stats.symbolNames.filter(name => name !== term && name.includes(term)).length;
		const symbolTf = symbolExactMatches * 3 + symbolPartialMatches;

		score += bm25Score(pathTf, stats.pathLength, lexicalStats.avgPathLength, bm25Idf(documentCount, lexicalStats.pathDf.get(term) ?? 0)) * 7;
		score += bm25Score(symbolTf, stats.symbolLength, lexicalStats.avgSymbolLength, bm25Idf(documentCount, lexicalStats.symbolDf.get(term) ?? 0)) * 11;
		score += bm25Score(Math.min(contentTf, 8), stats.contentLength, lexicalStats.avgContentLength, bm25Idf(documentCount, lexicalStats.contentDf.get(term) ?? 0)) * 2.5;

		if (basenameNoExt === term) {
			score += 28;
		}
		else if (basenameNoExt.startsWith(term) || basenameNoExt.endsWith(term)) {
			score += 16;
		}
		if (symbolExactMatches > 0) {
			score += 24;
		}
		if (stats.path.includes(`/${term}.`) || stats.path.endsWith(`/${term}`)) {
			score += 12;
		}
	}

	if (
		LOW_SIGNAL_BASENAME_SUFFIXES.some(suffix => basenameNoExt.endsWith(suffix)) &&
		!terms.some(term => LOW_SIGNAL_BASENAME_SUFFIXES.includes(stripExtension(term).toLowerCase()) || ['schema', 'definition'].includes(term.toLowerCase()))
	) {
		score -= 50;
	}

	return score;
};

const countRegexMatches = (content: string, pattern: RegExp): number => {
	return [...content.matchAll(pattern)].length;
};

const scoreSearchCodebaseQueryStructure = (
	file: GatherContextFileInput,
	searchType: SearchCodebaseSearchType,
	anchors: string[],
	lexicalStats: SearchCodebaseLexicalStats,
): number => {
	if (anchors.length === 0) {
		return 0;
	}

	const stats = lexicalStats.byPath.get(file.path);
	if (!stats) {
		return 0;
	}

	const basenameNoExt = basenameWithoutExtension(stats.path);
	let score = 0;

	for (const anchor of anchors) {
		const exactSymbolDefinitions = stats.symbolNames.filter(name => name === anchor).length;
		const partialSymbolDefinitions = stats.symbolNames.filter(name => name !== anchor && name.includes(anchor)).length;
		const declarationPattern = new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var|enum)\\s+${escapeRegex(anchor)}\\b`, 'g');
		const namedToolPattern = new RegExp(`\\bname\\s*:\\s*['"]${escapeRegex(anchor)}['"]`, 'g');
		const callPattern = new RegExp(`(?:\\.|\\b)${escapeRegex(anchor)}\\s*\\(`, 'g');
		const importPattern = new RegExp(`\\b(?:import|from|require\\()([^\\n]+)${escapeRegex(anchor)}`, 'g');
		const declarationMatches = countRegexMatches(stats.content, declarationPattern) + countRegexMatches(stats.content, namedToolPattern);
		const callMatches = countRegexMatches(stats.content, callPattern);
		const importMatches = countRegexMatches(stats.content, importPattern);
		const basenameExact = basenameNoExt === anchor;
		const basenamePartial = basenameNoExt.includes(anchor);

		if (searchType === 'definition') {
			score += exactSymbolDefinitions * 38;
			score += partialSymbolDefinitions * 12;
			score += declarationMatches * 28;
			if (basenameExact) score += 20;
			else if (basenamePartial) score += 10;
			if (callMatches > 0 && declarationMatches === 0 && exactSymbolDefinitions === 0) {
				score -= 8;
			}
			if (importMatches > 0 && declarationMatches === 0 && exactSymbolDefinitions === 0) {
				score -= 10;
			}
		}
		else if (searchType === 'callers') {
			score += callMatches * 42;
			score += importMatches * 10;
			if (callMatches > 0 && declarationMatches === 0) {
				score += 12;
			}
			score -= exactSymbolDefinitions * 42;
			score -= partialSymbolDefinitions * 12;
			score -= declarationMatches * 34;
			if (basenameExact) score -= 32;
			else if (basenamePartial) score -= 18;
			if (stats.path.includes('/test/') || stats.path.includes('.test.') || stats.path.includes('.spec.')) {
				score -= 48;
			}
			if (callMatches === 0 && (declarationMatches > 0 || exactSymbolDefinitions > 0)) {
				score -= 24;
			}
			if (callMatches === 0 && importMatches > 0) {
				score -= 10;
			}
		}
		else if (searchType === 'references') {
			score += callMatches * 16;
			score += importMatches * 16;
			score += exactSymbolDefinitions * 6;
			if (basenameExact) score += 6;
		}
		else if (searchType === 'ownership') {
			score += exactSymbolDefinitions * 18;
			score += declarationMatches * 18;
			score += partialSymbolDefinitions * 6;
			if (stats.path.includes('.impl.') || stats.path.includes('implementation')) {
				score += 10;
			}
			if (basenameExact) score += 10;
			else if (basenamePartial) score += 6;
		}
	}

	return score;
};

const buildStructuralMetrics = (files: GatherContextFileInput[], terms: string[]): Map<string, StructuralMetrics> => {
	const pathKeys = new Set(files.map(file => stripExtension(normalizePath(file.path)).toLowerCase()));
	const importedByCount = new Map<string, number>();

	for (const file of files) {
		const content = file.content ?? '';
		if (!content) {
			continue;
		}

		const importerPath = normalizePath(file.path);
		const seenTargets = new Set<string>();
		for (const specifier of getImportSpecifiers(content)) {
			const resolved = resolveImportTarget(importerPath, specifier);
			if (!resolved || !pathKeys.has(resolved) || seenTargets.has(resolved)) {
				continue;
			}
			seenTargets.add(resolved);
			importedByCount.set(resolved, (importedByCount.get(resolved) ?? 0) + 1);
		}
	}

	const metrics = new Map<string, StructuralMetrics>();
	for (const file of files) {
		const normalizedPath = normalizePath(file.path);
		const content = file.content ?? '';
		const importCount = file.importCount ?? (content ? getImportSpecifiers(content).length : 0);
		const pathKey = stripExtension(normalizedPath).toLowerCase();
		const basename = basenameWithoutExtension(normalizedPath);
		const basenameExactMatch = terms.some(term => stripExtension(term).toLowerCase() === basename);
		metrics.set(normalizedPath, {
			exportCount: countExports(file),
			importCount,
			importedByCount: file.importedByCount ?? importedByCount.get(pathKey) ?? 0,
			basenameExactMatch,
			modifiedTimeMs: file.modifiedTimeMs,
		});
	}

	return metrics;
};

const buildStructuralThresholds = (metricsByPath: Map<string, StructuralMetrics>): StructuralThresholds => {
	const metrics = [...metricsByPath.values()];
	return {
		exportCount: topBucketThreshold(metrics.map(metric => metric.exportCount)),
		importedByCount: topBucketThreshold(metrics.map(metric => metric.importedByCount)),
		importCountLow: lowBucketThreshold(metrics.map(metric => metric.importCount)),
		modifiedTimeMs: topBucketThreshold(metrics.map(metric => metric.modifiedTimeMs ?? 0)),
	};
};

const scoreStructuralSignals = (metrics: StructuralMetrics, thresholds: StructuralThresholds): number => {
	let score = 0;

	if (metrics.basenameExactMatch) {
		score += 28;
	}

	if (thresholds.exportCount !== undefined && metrics.exportCount >= thresholds.exportCount) {
		score += 15;
	}

	if (thresholds.importedByCount !== undefined && metrics.importedByCount >= thresholds.importedByCount) {
		score += 32;
	}

	if (
		thresholds.importedByCount !== undefined &&
		thresholds.importCountLow !== undefined &&
		metrics.importedByCount >= thresholds.importedByCount &&
		(metrics.importCount === 0 || metrics.importCount <= thresholds.importCountLow)
	) {
		score += 14;
	}

	if (
		thresholds.modifiedTimeMs !== undefined &&
		metrics.modifiedTimeMs !== undefined &&
		metrics.modifiedTimeMs >= thresholds.modifiedTimeMs
	) {
		score += 8;
	}

	return score;
};

export const extractContextTerms = (task: string): string[] => {
	const rawTerms = task.match(/[A-Za-z0-9_./:-]+/g) ?? [];
	const terms = new Set<string>();
	const orderedTerms: string[] = [];

	for (const rawTerm of rawTerms) {
		for (const variant of normalizeWordVariants(rawTerm)) {
			if (variant.length >= 3 && !STOP_WORDS.has(variant)) {
				terms.add(variant);
				orderedTerms.push(variant);
			}
		}

		for (const part of splitIdentifier(rawTerm)) {
			for (const normalized of normalizeWordVariants(part)) {
				if (normalized.length < 3 || STOP_WORDS.has(normalized)) {
					continue;
				}
				terms.add(normalized);
				orderedTerms.push(normalized);
			}
		}
	}

	for (let i = 0; i < orderedTerms.length - 1; i++) {
		const first = orderedTerms[i];
		const second = orderedTerms[i + 1];
		if (first.length < 3 || second.length < 3) {
			continue;
		}
		const joined = `${first}${second}`;
		if (joined.length >= 6) {
			terms.add(joined);
		}
	}

	for (let i = 0; i < orderedTerms.length - 2; i++) {
		const joined = `${orderedTerms[i]}${orderedTerms[i + 1]}${orderedTerms[i + 2]}`;
		if (joined.length >= 9) {
			terms.add(joined);
		}
	}

	for (const rawTerm of rawTerms) {
		for (const part of splitIdentifier(rawTerm)) {
			const normalized = part.toLowerCase();
			if (normalized.length < 3 || STOP_WORDS.has(normalized)) {
				continue;
			}
			terms.add(normalized);
		}
	}

	return [...terms].slice(0, 24);
};

export const shouldIncludeContextPath = (path: string): boolean => {
	const normalized = normalizePath(path);
	const segments = normalized.split('/').filter(Boolean);
	if (!segments.length) {
		return false;
	}

	for (const segment of segments) {
		if (EXCLUDED_SEGMENTS.has(segment) || segment.startsWith('.')) {
			return false;
		}
		if (/\b(out|build)\b/i.test(segment)) {
			return false;
		}
	}

	const lastSegment = segments[segments.length - 1].toLowerCase();
	if (EXCLUDED_BASENAMES.has(lastSegment) || lastSegment.endsWith('.resolved')) {
		return false;
	}
	const dotIndex = lastSegment.lastIndexOf('.');
	const extension = dotIndex === -1 ? '' : lastSegment.slice(dotIndex);
	return !BINARY_EXTENSIONS.has(extension);
};

const countOccurrences = (haystack: string, needle: string): number => {
	if (!needle) {
		return 0;
	}

	let count = 0;
	let index = 0;
	while ((index = haystack.indexOf(needle, index)) !== -1) {
		count++;
		index += needle.length;
	}
	return count;
};

const buildTermWeights = (files: GatherContextFileInput[], terms: string[]): Map<string, number> => {
	const weights = new Map<string, number>();
	if (files.length === 0) {
		return weights;
	}

	for (const term of terms) {
		let documentFrequency = 0;
		for (const file of files) {
			const haystack = `${normalizePath(file.path).toLowerCase()}\n${file.content?.toLowerCase() ?? ''}\n${file.symbols?.map(symbol => symbol.name.toLowerCase()).join('\n') ?? ''}`;
			if (haystack.includes(term.toLowerCase())) {
				documentFrequency++;
			}
		}
		const inverseDocumentWeight = Math.log((files.length + 1) / (documentFrequency + 1)) + 1;
		weights.set(term, Math.max(0.5, Math.min(4, inverseDocumentWeight)));
	}

	return weights;
};

export const scoreContextFile = (file: GatherContextFileInput, terms: string[], termWeights?: Map<string, number>): number => {
	const path = normalizePath(file.path).toLowerCase();
	const basename = path.split('/').pop() ?? path;
	const basenameNoExt = basenameWithoutExtension(path);
	const content = file.content?.toLowerCase() ?? '';
	let score = Math.max(0, file.searchHitCount ?? 0) * 10;

	for (const term of terms) {
		const weight = termWeights?.get(term) ?? 1;
		const normalizedTerm = stripExtension(term).toLowerCase();
		if (basenameNoExt === normalizedTerm) {
			score += 20 * weight;
		}
		else if (basenameNoExt.startsWith(normalizedTerm) || basenameNoExt.endsWith(normalizedTerm)) {
			score += 16 * weight;
		}
		else if (basename.includes(term)) {
			score += 8 * weight;
		}
		else if (path.includes(term)) {
			score += 3 * weight;
		}

		if (content) {
			score += Math.min(countOccurrences(content, term), 4) * weight;
		}
	}

	if (file.symbols?.length) {
		let exactSymbolMatches = 0;
		let partialSymbolMatches = 0;
		for (const symbol of file.symbols) {
			const normalizedSymbol = symbol.name.toLowerCase();
			for (const term of terms) {
				if (normalizedSymbol === term) {
					exactSymbolMatches++;
				}
				else if (normalizedSymbol.includes(term)) {
					partialSymbolMatches++;
				}
			}
		}
		score += Math.min(exactSymbolMatches, 3) * 12;
		score += Math.min(partialSymbolMatches, 6) * 4;
	}

	if (
		LOW_SIGNAL_BASENAME_SUFFIXES.some(suffix => basenameNoExt.endsWith(suffix)) &&
		!terms.some(term => LOW_SIGNAL_BASENAME_SUFFIXES.includes(stripExtension(term).toLowerCase()) || ['schema', 'definition'].includes(term.toLowerCase()))
	) {
		score -= 50;
	}

	return score;
};

export const gatherContextFromInputs = (
	task: string,
	files: GatherContextFileInput[],
	options: GatherContextOptions = {},
): GatheredContext => {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const terms = extractContextTerms(task);
	const includedFiles = files
		.map(file => ({ ...file, path: normalizePath(file.path) }))
		.filter(file => shouldIncludeContextPath(file.path));

	const fileTree = includedFiles
		.map(file => file.path)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, opts.maxFileTreeEntries);

	const termWeights = buildTermWeights(includedFiles, terms);
	const metricsByPath = buildStructuralMetrics(includedFiles, terms);
	const thresholds = buildStructuralThresholds(metricsByPath);
	const normalizedTask = task.toLowerCase();
	const isTestQuery = hasAnyTerm(normalizedTask, [' test', 'tests', 'spec', '.test', '.spec']);
	const isGathererQuery = hasAnyTerm(normalizedTask, ['context gather', 'gather context', 'contextgather', 'ranking', 'rerank', 'judgement layer', 'judgment layer']);

	const ranked = includedFiles
		.map(file => ({
			file,
			score: (() => {
				const structuralMetrics = metricsByPath.get(file.path) ?? {
					exportCount: 0,
					importCount: 0,
					importedByCount: 0,
					basenameExactMatch: false,
				};
				let score = scoreContextFile(file, terms, termWeights) + scoreStructuralSignals(structuralMetrics, thresholds);
				const normalizedPath = normalizePath(file.path).toLowerCase();
				if (!isTestQuery && hasAnyTerm(normalizedPath, ['/test/', '.test.', '.spec.'])) {
					score -= 60;
				}
				if (!isGathererQuery && hasAnyTerm(normalizedPath, ['/common/contextgathering/contextgatherer.ts'])) {
					score -= 70;
				}
				return score;
			})(),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			return a.file.path.localeCompare(b.file.path);
		})
		.slice(0, opts.maxRelevantFiles);

	const relevantFiles = ranked.map(({ file, score }, index): GatheredContextFile => {
		const includeContent = index < opts.maxFullContentFiles && typeof file.content === 'string';
		const content = includeContent ? file.content ?? '' : undefined;
		const truncatedContent = content !== undefined && content.length > opts.maxContentChars
			? content.slice(0, opts.maxContentChars)
			: content;

		return {
			path: file.path,
			relevanceScore: score,
			searchHitCount: Math.max(0, file.searchHitCount ?? 0),
			symbols: file.symbols ?? [],
			...(truncatedContent !== undefined ? { content: truncatedContent } : {}),
			...(content !== undefined ? { contentTruncated: content.length > opts.maxContentChars } : {}),
		};
	});

	return {
		task,
		terms,
		fileTree,
		relevantFiles,
	};
};

export const rankSearchCodebaseCandidates = (
	query: string,
	files: GatherContextFileInput[],
	options: { searchType: SearchCodebaseSearchType; maxCandidates?: number } = { searchType: 'ownership' },
): SearchCodebaseCandidate[] => {
	const searchType = options.searchType;
	const maxCandidates = options.maxCandidates ?? 8;
	const terms = extractSearchCodebaseTerms(query);
	const anchors = extractSearchCodebaseAnchors(query);
	const includedFiles = files
		.map(file => ({ ...file, path: normalizePath(file.path) }))
		.filter(file => shouldIncludeContextPath(file.path));

	const lexicalStats = buildSearchCodebaseLexicalStats(includedFiles, terms);
	const metricsByPath = buildStructuralMetrics(includedFiles, terms);
	const thresholds = buildStructuralThresholds(metricsByPath);
	const normalizedQuery = query.toLowerCase();
	const isTestQuery = hasAnyTerm(normalizedQuery, [' test', 'tests', 'spec', '.test', '.spec']);
	const isGathererQuery = hasAnyTerm(normalizedQuery, ['context gather', 'gather context', 'contextgather', 'ranking', 'rerank', 'judgement layer', 'judgment layer']);

	const candidates = includedFiles
		.map(file => {
			const structuralMetrics = metricsByPath.get(file.path) ?? {
				exportCount: 0,
				importCount: 0,
				importedByCount: 0,
				basenameExactMatch: false,
			};
			const ripgrepScore = scoreSearchCodebaseFile(file, terms, lexicalStats);
			let structuralScore = scoreStructuralSignals(structuralMetrics, thresholds);
			structuralScore += scoreSearchCodebaseQueryStructure(file, searchType, anchors, lexicalStats);
			const normalizedPath = file.path.toLowerCase();
			let lexicalScore = ripgrepScore;
			if ((file.graphHitCount ?? 0) > 0) {
				structuralScore += (file.graphHitCount ?? 0) * 8;
			}
			if (searchType === 'callers' && anchors.length > 0) {
				const basenameNoExt = basenameWithoutExtension(normalizedPath);
				const basenameAnchorMatches = anchors.filter(anchor => basenameNoExt.includes(anchor)).length;
				if (basenameAnchorMatches > 0) {
					lexicalScore -= basenameAnchorMatches * 28;
				}
				if (hasAnyTerm(normalizedPath, ['/test/', '.test.', '.spec.'])) {
					lexicalScore -= 36;
				}
				if ((file.callerHitCount ?? 0) > 0) {
					structuralScore += (file.callerHitCount ?? 0) * 22;
				}
			}
			if (!isTestQuery && (searchType === 'ownership' || searchType === 'definition') && hasAnyTerm(normalizedPath, ['/test/', '.test.', '.spec.'])) {
				structuralScore -= 60;
			}
			if (!isGathererQuery && hasAnyTerm(normalizedPath, ['/common/contextgathering/contextgatherer.ts', '/common/contextgathering/searchcodebasetool.ts'])) {
				structuralScore -= 70;
			}
			if ((searchType === 'references' || searchType === 'callers') && structuralMetrics.importedByCount > 0) {
				structuralScore += 10;
			}
			if ((searchType === 'ownership' || searchType === 'definition') && structuralMetrics.exportCount > 0) {
				structuralScore += 6;
			}
			const content = file.content ?? '';
			const evidenceTerms = dedupeOrdered([...anchors, ...terms]).slice(0, 16);
			const evidenceSnippets = extractEvidenceSnippets(content, evidenceTerms, 6);
			const snippetPreview = evidenceSnippets
				.map(snippet => `[lines ${snippet.startLine}-${snippet.endLine}]\n${snippet.text}`)
				.join('\n...\n');
			const preview = file.contextSummary
				? `${file.contextSummary}${snippetPreview ? `\n\n${snippetPreview}` : (content ? `\n\n${firstLines(content, 14)}` : '')}`
				: (snippetPreview || (content ? firstLines(content, 20) : ''));
			const lineCount = file.lineCount ?? (content ? content.split('\n').length : 0);
			return {
				...file,
				ripgrepScore: lexicalScore,
				structuralScore,
				totalScore: lexicalScore + structuralScore,
				contentPreview: preview,
				evidenceSnippets,
				lineCount,
			} satisfies SearchCodebaseCandidate;
		})
		.filter(candidate => candidate.totalScore > 0)
		.sort((a, b) => {
			if (b.totalScore !== a.totalScore) {
				return b.totalScore - a.totalScore;
			}
			return a.path.localeCompare(b.path);
		})
		.slice(0, maxCandidates);

	return candidates;
};

export const formatGatheredContextForPrompt = (context: GatheredContext): string => {
	if (context.relevantFiles.length === 0) {
		return '';
	}

	const files = context.relevantFiles.map(file => {
		const symbols = file.symbols.length
			? `\nSymbols: ${file.symbols.slice(0, 24).map(symbol => `${symbol.name} (${symbol.kind})`).join(', ')}`
			: '';
		const content = file.content
			? `\nContent:\n\`\`\`\n${file.content}${file.contentTruncated ? '\n... file truncated ...' : ''}\n\`\`\``
			: '';
		return `File: ${file.path}\nRelevance score: ${file.relevanceScore}\nSearch hits: ${file.searchHitCount}${symbols}${content}`;
	});

	return `Task terms: ${context.terms.join(', ') || '(none)'}\n\nRelevant files:\n${files.join('\n\n')}`;
};

export const summarizeGatheredContextForLog = (context: GatheredContext, maxFiles = 3): string => {
	if (context.relevantFiles.length === 0) {
		return 'none';
	}

	return context.relevantFiles
		.slice(0, Math.max(1, maxFiles))
		.map(file => `${file.path} (${file.relevanceScore})`)
		.join(', ');
};
