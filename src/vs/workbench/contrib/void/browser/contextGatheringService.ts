import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Position } from '../../../../editor/common/core/position.js';
import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Range, IRange } from '../../../../editor/common/core/range.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { URI } from '../../../../base/common/uri.js';
import { ISearchService, QueryType, isFileMatch, resultIsMatch } from '../../../services/search/common/search.js';
import { IAiEmbeddingVectorService } from '../../../services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { GatheredContext, GatherContextFileInput, GatherContextSymbol, SearchCodebaseCandidate, SearchCodebaseSearchType, dedupeOrdered, extractContextTerms, extractSearchCodebaseAnchors, extractSearchCodebaseTerms, gatherContextFromInputs, rankSearchCodebaseCandidates } from '../common/contextGathering/contextGatherer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IndexedContextNeighborhood, IVoidIndexService, RankedDirectory } from '../common/index/indexServiceTypes.js';


// make sure snippet logic works
// change logic for `visited` to intervals
// atomically set new snippets at end
// throttle cache setting

interface IVisitedInterval {
	uri: string;
	startLine: number;
	endLine: number;
}

export interface IContextGatheringService {
	readonly _serviceBrand: undefined;
	updateCache(model: ITextModel, pos: Position): Promise<void>;
	getCachedSnippets(): string[];
	getSemanticSnippets(query: string): Promise<string[]>;
	gatherContext(task: string, workspaceRoot?: URI): Promise<GatheredContext>;
	searchCodebaseCandidates(query: string, searchType: SearchCodebaseSearchType, opts?: { workspaceRoot?: URI; extraTerms?: string[] }): Promise<SearchCodebaseCandidate[]>;
}

export const IContextGatheringService = createDecorator<IContextGatheringService>('contextGatheringService');

class ContextGatheringService extends Disposable implements IContextGatheringService {
	_serviceBrand: undefined;
	private readonly _NUM_LINES = 3;
	private readonly _MAX_SNIPPET_LINES = 7;  // Reasonable size for context
	// Cache holds the most recent list of snippets.
	private _cache: string[] = [];
	private _snippetIntervals: IVisitedInterval[] = [];

	constructor(
		@ILanguageFeaturesService private readonly _langFeaturesService: ILanguageFeaturesService,
		@IModelService private readonly _modelService: IModelService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@ISearchService private readonly _searchService: ISearchService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IDirectoryStrService private readonly _directoryStrService: IDirectoryStrService,
		@IAiEmbeddingVectorService private readonly _aiEmbeddingVectorService: IAiEmbeddingVectorService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@IFileService private readonly _fileService: IFileService,
		@IVoidIndexService private readonly _voidIndexService: IVoidIndexService,
	) {
		super();
		this._modelService.getModels().forEach(model => this._subscribeToModel(model));
		this._register(this._modelService.onModelAdded(model => this._subscribeToModel(model)));
	}

	private _subscribeToModel(model: ITextModel): void {
		console.log('Subscribing to model:', model.uri.toString());
		this._register(model.onDidChangeContent(() => {
			const editor = this._codeEditorService.getFocusedCodeEditor();
			if (editor && editor.getModel() === model) {
				const pos = editor.getPosition();
				console.log('updateCache called at position:', pos);
				if (pos) {
					this.updateCache(model, pos);
				}
			}
		}));
	}

	public async updateCache(model: ITextModel, pos: Position): Promise<void> {
		const snippets = new Set<string>();
		this._snippetIntervals = []; // Reset intervals for new cache update

		await this._gatherNearbySnippets(model, pos, this._NUM_LINES, 3, snippets, this._snippetIntervals);
		await this._gatherParentSnippets(model, pos, this._NUM_LINES, 3, snippets, this._snippetIntervals);

		// Convert to array and filter overlapping snippets
		this._cache = Array.from(snippets);
		console.log('Cache updated:', this._cache);
	}

	public getCachedSnippets(): string[] {
		return this._cache;
	}

	public async getSemanticSnippets(query: string): Promise<string[]> {
		const searchStart = Date.now();
		console.log(`Void: Performing semantic search for: ${query}`);
		if (!this._aiEmbeddingVectorService.isEnabled()) {
			console.log(`Void: Semantic search skipped because embeddings are disabled (${Date.now() - searchStart}ms).`);
			return [];
		}

		try {
			const results = await this._searchService.aiTextSearch({
				contentPattern: query,
				type: QueryType.aiText,
				folderQueries: this._workspaceContextService.getWorkspace().folders.map(f => ({ folder: f.uri })),
				maxResults: 10
			}, CancellationToken.None);

			const snippets: string[] = [];
			for (const result of results.results) {
				if (isFileMatch(result)) {
					const { model } = await this._voidModelService.getModelSafe(result.resource);
					if (model) {
						for (const searchResult of result.results || []) {
							if (resultIsMatch(searchResult)) {
								const range = searchResult.rangeLocations[0].source;
								const snippet = this._getSnippetForRange(model, range, 2);
								snippets.push(`File: ${result.resource.fsPath}\n${snippet}`);
							}
						}
					}
				}
			}
			console.log(`Void: Found ${snippets.length} semantic snippets in ${Date.now() - searchStart}ms.`);
			return snippets;
		} catch (e) {
			console.error(`Semantic search error after ${Date.now() - searchStart}ms:`, e);
			return [];
		}
	}

	public async gatherContext(task: string, workspaceRoot?: URI): Promise<GatheredContext> {
		const workspaceFolders = workspaceRoot
			? [workspaceRoot]
			: this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		const roots = workspaceFolders.filter(Boolean);
		if (!roots.length) {
			return gatherContextFromInputs(task, []);
		}

		const fileUris = await this._collectWorkspaceFiles(roots);
		const searchHitCounts = await this._collectSearchHitCounts(task, roots);
		const initialFiles = fileUris.map(uri => ({
			path: this._relativePath(uri, roots),
			uri: uri.toString(),
			searchHitCount: searchHitCounts.get(uri.toString()) ?? 0,
		} satisfies GatherContextFileInput));

		const initialContext = gatherContextFromInputs(task, initialFiles, {
			maxFullContentFiles: 0,
			maxRelevantFiles: 8,
		});
		const candidatePaths = new Set(initialContext.relevantFiles.map(file => file.path));
		if (candidatePaths.size === 0) {
			for (const file of initialFiles) {
				if ((file.searchHitCount ?? 0) > 0) {
					candidatePaths.add(file.path);
				}
				if (candidatePaths.size >= 8) {
					break;
				}
			}
		}

		const enrichedFiles = await Promise.all(initialFiles.map(async file => {
			if (!candidatePaths.has(file.path)) {
				return file;
			}

			const uri = fileUris.find(candidateUri => this._relativePath(candidateUri, roots) === file.path);
			if (!uri) {
				return file;
			}

			const { content, symbols } = await this._readContextFile(uri);
			return {
				...file,
				content,
				symbols,
			};
		}));

		return gatherContextFromInputs(task, enrichedFiles, {
			maxFileTreeEntries: 1000,
			maxRelevantFiles: 8,
			maxFullContentFiles: 3,
			maxContentChars: 20000,
		});
	}

	public async searchCodebaseCandidates(query: string, searchType: SearchCodebaseSearchType, opts?: { workspaceRoot?: URI; extraTerms?: string[] }): Promise<SearchCodebaseCandidate[]> {
		const workspaceRoot = opts?.workspaceRoot;
		const extraTerms = opts?.extraTerms ?? [];

		const workspaceFolders = workspaceRoot
			? [workspaceRoot]
			: this._workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		const roots = workspaceFolders.filter(Boolean);
		if (!roots.length) {
			return [];
		}

		const fileUris = await this._collectWorkspaceFiles(roots);
		const searchTerms = dedupeOrdered([...extractSearchCodebaseTerms(query), ...extraTerms]);

		// Phase 1: Directory Discovery
		let rankedDirs: RankedDirectory[] = [];
		try {
			const rawDirs = await this._voidIndexService.searchDirectories(query, 5);
			rankedDirs = rawDirs.filter(d => roots.some(root => d.uri.toString().startsWith(root.toString())));
		} catch (e) {
			console.warn('Void: searchDirectories failed:', e);
		}
		const scopedRoots = rankedDirs.length > 0 ? rankedDirs.map(d => d.uri) : roots;

		// Phase 2: Scoped Search
		let searchHitCounts = await this._collectSearchHitCountsFromTerms(searchTerms, scopedRoots);

		// Phase 3: Rediscovery (Fallback to global if scoped search is too narrow)
		if (searchHitCounts.size < 5 && rankedDirs.length > 0) {
			try {
				const globalHits = await this._collectSearchHitCountsFromTerms(searchTerms, roots);
				for (const [uri, count] of globalHits) {
					searchHitCounts.set(uri, (searchHitCounts.get(uri) ?? 0) + count);
				}
			} catch (e) {
				console.warn('Void: global fallback search failed:', e);
			}
		}

		const neighborhoods = await this._collectContextNeighborhoods(query, searchType, roots);
		const neighborhoodsByUri = new Map(neighborhoods.map(neighborhood => [neighborhood.uri.toString(), neighborhood] as const));
		const callerHitCounts = searchType === 'callers'
			? await this._collectCallerHitCounts(query, roots)
			: new Map<string, number>();
		const initialFiles = fileUris.map(uri => ({
			path: this._relativePath(uri, roots),
			uri: uri.toString(),
			searchHitCount: searchHitCounts.get(uri.toString()) ?? 0,
			graphHitCount: neighborhoodsByUri.get(uri.toString())?.score ?? 0,
			callerHitCount: callerHitCounts.get(uri.toString()) ?? 0,
		} satisfies GatherContextFileInput));

		const topStaticCandidates = rankSearchCodebaseCandidates(query, initialFiles, {
			searchType,
			maxCandidates: 20,
		});

		const uriByRelativePath = new Map(fileUris.map(uri => [this._relativePath(uri, roots), uri] as const));
		const enrichedFiles = await Promise.all(topStaticCandidates.map(async candidate => {
			const uri = uriByRelativePath.get(candidate.path);
			if (!uri) {
				return candidate;
			}

			const { content, symbols } = await this._readContextFile(uri, 300);
			const neighborhood = neighborhoodsByUri.get(uri.toString());
			const contextSummary = neighborhood ? this._formatNeighborhoodSummary(candidate.path, neighborhood, roots) : undefined;
			const importCount = content ? this._countImportStatements(content) : 0;
			const importedByCount = await this._countImportFanOut(candidate.path, roots);
			const modifiedTimeMs = await this._getModifiedTimeMs(uri);
			return {
				path: candidate.path,
				uri: uri.toString(),
				content,
				contextSummary,
				symbols,
				searchHitCount: candidate.searchHitCount,
				graphHitCount: candidate.graphHitCount,
				callerHitCount: candidate.callerHitCount,
				importCount,
				importedByCount,
				modifiedTimeMs,
				lineCount: content ? content.split('\n').length : 0,
			} satisfies GatherContextFileInput;
		}));

		return rankSearchCodebaseCandidates(query, enrichedFiles, {
			searchType,
			maxCandidates: 8,
		});
	}

	private async _collectWorkspaceFiles(roots: URI[]): Promise<URI[]> {
		const allUris: URI[] = [];
		for (const root of roots) {
			try {
				const uris = await this._directoryStrService.getAllURIsInDirectory(root, { maxResults: 5000 });
				allUris.push(...uris);
			} catch (e) {
				console.warn('Void: gatherContext failed to enumerate workspace files:', e);
			}
		}
		return allUris;
	}

	private async _collectSearchHitCounts(task: string, roots: URI[]): Promise<Map<string, number>> {
		const terms = extractContextTerms(task);
		return this._collectSearchHitCountsFromTerms(terms, roots);
	}

	private async _collectSearchHitCountsFromTerms(terms: string[], roots: URI[]): Promise<Map<string, number>> {
		const hitCounts = new Map<string, number>();
		if (terms.length === 0) {
			return hitCounts;
		}

		try {
			const queryBuilder = this._instantiationService.createInstance(QueryBuilder);
			const pattern = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
			const query = queryBuilder.text({
				pattern,
				isRegExp: true,
			}, roots);
			const results = await this._searchService.textSearch(query, CancellationToken.None);
			for (const result of results.results) {
				if (!isFileMatch(result)) {
					continue;
				}
				hitCounts.set(result.resource.toString(), result.results?.length ?? 1);
			}
		} catch (e) {
			console.warn('Void: gatherContext text search failed:', e);
		}

		return hitCounts;
	}

	private async _collectContextNeighborhoods(query: string, searchType: SearchCodebaseSearchType, roots: URI[]): Promise<IndexedContextNeighborhood[]> {
		try {
			const neighborhoods = await this._voidIndexService.getContextNeighborhoods(query, { intent: searchType, limit: 12 });
			return neighborhoods.filter(neighborhood => roots.some(root => neighborhood.uri.toString().startsWith(root.toString())));
		} catch (e) {
			console.warn('Void: neighborhood index search failed:', e);
			return [];
		}
	}

	private async _collectCallerHitCounts(query: string, roots: URI[]): Promise<Map<string, number>> {
		const hitCounts = new Map<string, number>();
		const anchors = extractSearchCodebaseAnchors(query).slice(0, 3);
		if (anchors.length === 0) {
			return hitCounts;
		}

		try {
			const results = await Promise.all(anchors.map(anchor => this._voidIndexService.searchCallers(anchor)));
			for (const symbols of results) {
				for (const symbol of symbols) {
					const uri = URI.parse(symbol.uri.toString());
					if (!roots.some(root => uri.toString().startsWith(root.toString()))) {
						continue;
					}
					hitCounts.set(uri.toString(), (hitCounts.get(uri.toString()) ?? 0) + 4);
				}
			}
		} catch (e) {
			console.warn('Void: caller index search failed:', e);
		}

		return hitCounts;
	}

	private async _readContextFile(uri: URI, maxLines?: number): Promise<{ content: string | null; symbols: GatherContextSymbol[] }> {
		try {
			await this._voidModelService.initializeModel(uri);
			const { model } = await this._voidModelService.getModelSafe(uri);
			if (!model) {
				return { content: null, symbols: [] };
			}

			const content = maxLines && model.getLineCount() > maxLines
				? model.getValueInRange({
					startLineNumber: 1,
					startColumn: 1,
					endLineNumber: maxLines,
					endColumn: model.getLineMaxColumn(maxLines),
				}, EndOfLinePreference.LF)
				: model.getValue(EndOfLinePreference.LF);
			const symbols = await this._getContextSymbols(model);
			return { content, symbols };
		} catch (e) {
			console.warn('Void: gatherContext failed to read candidate file:', e);
			return { content: null, symbols: [] };
		}
	}

	private async _getContextSymbols(model: ITextModel): Promise<GatherContextSymbol[]> {
		const providers = this._langFeaturesService.documentSymbolProvider.ordered(model);
		for (const provider of providers) {
			try {
				const result = await provider.provideDocumentSymbols(model, CancellationToken.None);
				if (!result) {
					continue;
				}
				return this._flattenSymbols(result)
					.filter(symbol => this._isUsefulContextSymbol(symbol))
					.slice(0, 50)
					.map(symbol => ({
						name: symbol.name,
						kind: this._symbolKindLabel(symbol.kind),
						range: {
							startLine: symbol.range.startLineNumber,
							endLine: symbol.range.endLineNumber,
						},
					}));
			} catch (e) {
				console.warn('Void: gatherContext symbol provider error:', e);
			}
		}
		return [];
	}

	private _countImportStatements(content: string): number {
		return (content.match(/\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"][^'"]+['"]/g) ?? []).length
			+ (content.match(/\brequire\(\s*['"][^'"]+['"]\s*\)/g) ?? []).length
			+ (content.match(/\bexport\s+[^'"]*?\s+from\s+['"][^'"]+['"]/g) ?? []).length;
	}

	private async _countImportFanOut(relativePath: string, roots: URI[]): Promise<number> {
		const basename = relativePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
		if (!basename) {
			return 0;
		}

		try {
			const queryBuilder = this._instantiationService.createInstance(QueryBuilder);
			const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			// Use the same robust import pattern as our gatherer for consistency
			const importPattern = `(?:import|export|from|require\\(|use|mod)\\s*['"]?[^'"]*\\b${escapedBasename}\\b`;
			const query = queryBuilder.text({
				pattern: importPattern,
				isRegExp: true,
			}, roots);
			const results = await this._searchService.textSearch(query, CancellationToken.None);
			return results.results.filter(result => isFileMatch(result)).length;
		} catch (e) {
			console.warn('Void: searchCodebase import fan-out search failed:', e);
			return 0;
		}
	}

	private async _getModifiedTimeMs(uri: URI): Promise<number | undefined> {
		try {
			const stat = await this._fileService.stat(uri);
			return stat.mtime;
		} catch {
			return undefined;
		}
	}

	private _formatNeighborhoodSummary(path: string, neighborhood: IndexedContextNeighborhood, roots: URI[]): string {
		const anchorSummary = neighborhood.anchorNodes
			.slice(0, 4)
			.map(node => `${node.name} [${node.role ?? node.type}]`)
			.join(', ');
		const relatedSummary = neighborhood.relatedNodes
			.slice(0, 6)
			.map(node => {
				const relativePath = this._relativePath(node.uri, roots);
				return relativePath === path ? `${node.name} [${node.role ?? node.type}]` : `${node.name} -> ${relativePath}`;
			})
			.join(', ');
		const edgeSummary = neighborhood.edges
			.slice(0, 8)
			.map(edge => `${edge.type}:${edge.targetName ?? edge.targetId ?? edge.targetUri?.toString() ?? 'unknown'}`)
			.join(', ');

		return [
			`Context neighborhood score: ${Math.round(neighborhood.score)}`,
			anchorSummary ? `Anchors: ${anchorSummary}` : '',
			relatedSummary ? `Related: ${relatedSummary}` : '',
			edgeSummary ? `Edges: ${edgeSummary}` : '',
		].filter(Boolean).join('\n');
	}

	private _relativePath(uri: URI, roots: URI[]): string {
		const path = uri.fsPath.replace(/\\/g, '/');
		for (const root of roots) {
			const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
			if (path === rootPath) {
				return path.split('/').pop() ?? path;
			}
			if (path.startsWith(rootPath + '/')) {
				return path.slice(rootPath.length + 1);
			}
		}
		return path;
	}

	private _isUsefulContextSymbol(symbol: DocumentSymbol): boolean {
		return symbol.kind === SymbolKind.Function ||
			symbol.kind === SymbolKind.Method ||
			symbol.kind === SymbolKind.Class ||
			symbol.kind === SymbolKind.Interface ||
			symbol.kind === SymbolKind.Enum ||
			symbol.kind === SymbolKind.Constructor ||
			symbol.kind === SymbolKind.Module ||
			symbol.kind === SymbolKind.Namespace;
	}

	private _symbolKindLabel(kind: SymbolKind): string {
		switch (kind) {
			case SymbolKind.Function: return 'function';
			case SymbolKind.Method: return 'method';
			case SymbolKind.Class: return 'class';
			case SymbolKind.Interface: return 'interface';
			case SymbolKind.Enum: return 'enum';
			case SymbolKind.Constructor: return 'constructor';
			case SymbolKind.Module: return 'module';
			case SymbolKind.Namespace: return 'namespace';
			default: return 'symbol';
		}
	}

	// Basic snippet extraction.
	private _getSnippetForRange(model: ITextModel, range: IRange, numLines: number): string {
		const startLine = Math.max(range.startLineNumber - numLines, 1);
		const endLine = Math.min(range.endLineNumber + numLines, model.getLineCount());

		// Enforce maximum snippet size
		const totalLines = endLine - startLine + 1;
		const adjustedStartLine = totalLines > this._MAX_SNIPPET_LINES
			? endLine - this._MAX_SNIPPET_LINES + 1
			: startLine;

		const snippetRange = new Range(adjustedStartLine, 1, endLine, model.getLineMaxColumn(endLine));
		return this._cleanSnippet(model.getValueInRange(snippetRange));
	}

	private _cleanSnippet(snippet: string): string {
		return snippet
			.split('\n')
			// Remove empty lines and lines with only comments
			.filter(line => {
				const trimmed = line.trim();
				return trimmed && !/^\s*(\/\/|\/\*|\*|\#|\;|\-\-)/.test(trimmed);
			})
			// Rejoin with newlines
			.join('\n')
			// Remove excess whitespace
			.trim();
	}

	private _normalizeSnippet(snippet: string): string {
		return snippet
			// Remove multiple newlines
			.replace(/\n{2,}/g, '\n')
			// Remove trailing whitespace
			.trim();
	}

	private _addSnippetIfNotOverlapping(
		model: ITextModel,
		range: IRange,
		snippets: Set<string>,
		visited: IVisitedInterval[]
	): void {
		const startLine = range.startLineNumber;
		const endLine = range.endLineNumber;
		const uri = model.uri.toString();

		if (!this._isRangeVisited(uri, startLine, endLine, visited)) {
			visited.push({ uri, startLine, endLine });
			const snippet = this._normalizeSnippet(this._getSnippetForRange(model, range, this._NUM_LINES));
			if (snippet.length > 0) {
				snippets.add(snippet);
			}
		}
	}

	private async _gatherNearbySnippets(
		model: ITextModel,
		pos: Position,
		numLines: number,
		depth: number,
		snippets: Set<string>,
		visited: IVisitedInterval[]
	): Promise<void> {
		if (depth <= 0) return;

		const startLine = Math.max(pos.lineNumber - numLines, 1);
		const endLine = Math.min(pos.lineNumber + numLines, model.getLineCount());
		const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));

		this._addSnippetIfNotOverlapping(model, range, snippets, visited);

		const symbols = await this._getSymbolsNearPosition(model, pos, numLines);
		for (const sym of symbols) {
			const defs = await this._getDefinitionSymbols(model, sym);
			for (const def of defs) {
				const defModel = this._modelService.getModel(def.uri);
				if (defModel) {
					const defPos = new Position(def.range.startLineNumber, def.range.startColumn);
					this._addSnippetIfNotOverlapping(defModel, def.range, snippets, visited);
					await this._gatherNearbySnippets(defModel, defPos, numLines, depth - 1, snippets, visited);
				}
			}
		}
	}

	private async _gatherParentSnippets(
		model: ITextModel,
		pos: Position,
		numLines: number,
		depth: number,
		snippets: Set<string>,
		visited: IVisitedInterval[]
	): Promise<void> {
		if (depth <= 0) return;

		const container = await this._findContainerFunction(model, pos);
		if (!container) return;

		const containerRange = container.kind === SymbolKind.Method ? container.selectionRange : container.range;
		this._addSnippetIfNotOverlapping(model, containerRange, snippets, visited);

		const symbols = await this._getSymbolsNearRange(model, containerRange, numLines);
		for (const sym of symbols) {
			const defs = await this._getDefinitionSymbols(model, sym);
			for (const def of defs) {
				const defModel = this._modelService.getModel(def.uri);
				if (defModel) {
					const defPos = new Position(def.range.startLineNumber, def.range.startColumn);
					this._addSnippetIfNotOverlapping(defModel, def.range, snippets, visited);
					await this._gatherNearbySnippets(defModel, defPos, numLines, depth - 1, snippets, visited);
				}
			}
		}

		const containerPos = new Position(containerRange.startLineNumber, containerRange.startColumn);
		await this._gatherParentSnippets(model, containerPos, numLines, depth - 1, snippets, visited);
	}

	private _isRangeVisited(uri: string, startLine: number, endLine: number, visited: IVisitedInterval[]): boolean {
		return visited.some(interval =>
			interval.uri === uri &&
			!(endLine < interval.startLine || startLine > interval.endLine)
		);
	}

	private async _getSymbolsNearPosition(model: ITextModel, pos: Position, numLines: number): Promise<DocumentSymbol[]> {
		const startLine = Math.max(pos.lineNumber - numLines, 1);
		const endLine = Math.min(pos.lineNumber + numLines, model.getLineCount());
		const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
		return this._getSymbolsInRange(model, range);
	}

	private async _getSymbolsNearRange(model: ITextModel, range: IRange, numLines: number): Promise<DocumentSymbol[]> {
		const centerLine = Math.floor((range.startLineNumber + range.endLineNumber) / 2);
		const startLine = Math.max(centerLine - numLines, 1);
		const endLine = Math.min(centerLine + numLines, model.getLineCount());
		const searchRange = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
		return this._getSymbolsInRange(model, searchRange);
	}

	private async _getSymbolsInRange(model: ITextModel, range: IRange): Promise<DocumentSymbol[]> {
		const symbols: DocumentSymbol[] = [];
		const providers = this._langFeaturesService.documentSymbolProvider.ordered(model);
		for (const provider of providers) {
			try {
				const result = await provider.provideDocumentSymbols(model, CancellationToken.None);
				if (result) {
					const flat = this._flattenSymbols(result);
					const intersecting = flat.filter(sym => this._rangesIntersect(sym.range, range));
					symbols.push(...intersecting);
				}
			} catch (e) {
				console.warn('Symbol provider error:', e);
			}
		}
		// Also check reference providers.
		const refProviders = this._langFeaturesService.referenceProvider.ordered(model);
		for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
			const content = model.getLineContent(line);
			const words = content.match(/[a-zA-Z_]\w*/g) || [];
			for (const word of words) {
				const startColumn = content.indexOf(word) + 1;
				const pos = new Position(line, startColumn);
				if (!this._positionInRange(pos, range)) continue;
				for (const provider of refProviders) {
					try {
						const refs = await provider.provideReferences(model, pos, { includeDeclaration: true }, CancellationToken.None);
						if (refs) {
							const filtered = refs.filter(ref => this._rangesIntersect(ref.range, range));
							for (const ref of filtered) {
								symbols.push({
									name: word,
									detail: '',
									kind: SymbolKind.Variable,
									range: ref.range,
									selectionRange: ref.range,
									children: [],
									tags: []
								});
							}
						}
					} catch (e) {
						console.warn('Reference provider error:', e);
					}
				}
			}
		}
		return symbols;
	}

	private _flattenSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
		const flat: DocumentSymbol[] = [];
		for (const sym of symbols) {
			flat.push(sym);
			if (sym.children && sym.children.length > 0) {
				flat.push(...this._flattenSymbols(sym.children));
			}
		}
		return flat;
	}

	private _rangesIntersect(a: IRange, b: IRange): boolean {
		return !(
			a.endLineNumber < b.startLineNumber ||
			a.startLineNumber > b.endLineNumber ||
			(a.endLineNumber === b.startLineNumber && a.endColumn < b.startColumn) ||
			(a.startLineNumber === b.endLineNumber && a.endColumn > b.endColumn)
		);
	}

	private _positionInRange(pos: Position, range: IRange): boolean {
		return pos.lineNumber >= range.startLineNumber &&
			pos.lineNumber <= range.endLineNumber &&
			(pos.lineNumber !== range.startLineNumber || pos.column >= range.startColumn) &&
			(pos.lineNumber !== range.endLineNumber || pos.column <= range.endColumn);
	}

	// Get definition symbols for a given symbol.
	private async _getDefinitionSymbols(model: ITextModel, symbol: DocumentSymbol): Promise<(DocumentSymbol & { uri: URI })[]> {
		const pos = new Position(symbol.range.startLineNumber, symbol.range.startColumn);
		const providers = this._langFeaturesService.definitionProvider.ordered(model);
		const defs: (DocumentSymbol & { uri: URI })[] = [];
		for (const provider of providers) {
			try {
				const res = await provider.provideDefinition(model, pos, CancellationToken.None);
				if (res) {
					const links = Array.isArray(res) ? res : [res];
					defs.push(...links.map(link => ({
						name: symbol.name,
						detail: symbol.detail,
						kind: symbol.kind,
						range: link.range,
						selectionRange: link.range,
						children: [],
						tags: symbol.tags || [],
						uri: link.uri  // Now keeping it as URI instead of converting to string
					})));
				}
			} catch (e) {
				console.warn('Definition provider error:', e);
			}
		}
		return defs;
	}

	private async _findContainerFunction(model: ITextModel, pos: Position): Promise<DocumentSymbol | null> {
		const searchRange = new Range(
			Math.max(pos.lineNumber - 1, 1), 1,
			Math.min(pos.lineNumber + 1, model.getLineCount()),
			model.getLineMaxColumn(pos.lineNumber)
		);
		const symbols = await this._getSymbolsInRange(model, searchRange);
		const funcs = symbols.filter(s =>
			(s.kind === SymbolKind.Function || s.kind === SymbolKind.Method) &&
			this._positionInRange(pos, s.range)
		);
		if (!funcs.length) return null;
		return funcs.reduce((innermost, current) => {
			if (!innermost) return current;
			const moreInner =
				(current.range.startLineNumber > innermost.range.startLineNumber ||
					(current.range.startLineNumber === innermost.range.startLineNumber &&
						current.range.startColumn > innermost.range.startColumn)) &&
				(current.range.endLineNumber < innermost.range.endLineNumber ||
					(current.range.endLineNumber === innermost.range.endLineNumber &&
						current.range.endColumn < innermost.range.endColumn));
			return moreInner ? current : innermost;
		}, null as DocumentSymbol | null);
	}
}

registerSingleton(IContextGatheringService, ContextGatheringService, InstantiationType.Eager);
