/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ISearchService, ISearchResultProvider, SearchProviderType, ITextQuery, ISearchProgressItem, ISearchComplete, IFileQuery, IAITextQuery, FileMatch, TextSearchMatch, SearchRange } from '../../../services/search/common/search.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IAiEmbeddingVectorService } from '../../../services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { SymbolKind } from '../../../../editor/common/languages.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

export interface IVoidAiSearchProvider {
	readonly _serviceBrand: undefined;
}
export const IVoidAiSearchProvider = createDecorator<IVoidAiSearchProvider>('voidAiSearchProvider');

export class VoidAiSearchProvider implements IVoidAiSearchProvider, ISearchResultProvider, IWorkbenchContribution {

	static readonly ID = 'void.aiSearchProvider';
	_serviceBrand: undefined;
	private readonly _disposable: IDisposable;
	private readonly _store = new DisposableStore();
	private _indexCache: {
		chunks: {
			id: string;
			uri: string;
			startLine: number;
			endLine: number;
			content: string;
			symbolNames: string[];
		}[];
	} | null = null;
	private _isIndexReady = false;
	private _isBuildingIndex = false;
	private _backgroundBuildPromise: Promise<void> | null = null;
	private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly _embeddingByChunkId = new Map<string, number[]>();

	private static readonly _excludedPathSegments = new Set([
		'node_modules',
		'dist',
		'build',
		'out',
		'coverage',
		'vendor',
		'__pycache__',
		'env',
		'venv',
		'.venv',
		'site-packages',
	]);

	constructor(
		@ISearchService private readonly _searchService: ISearchService,
		@IAiEmbeddingVectorService private readonly _aiEmbeddingVectorService: IAiEmbeddingVectorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@IDirectoryStrService private readonly _directoryStrService: IDirectoryStrService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IModelService private readonly _modelService: IModelService,
	) {
		console.log('VoidAiSearchProvider: registering AI search provider');
		this._disposable = this._searchService.registerSearchResultProvider('file', SearchProviderType.aiText, this);
		this._store.add(this._disposable);
		this._store.add(this._modelService.onModelAdded(() => this._scheduleRebuild('model-added')));
		this._store.add(this._modelService.onModelRemoved(() => this._scheduleRebuild('model-removed')));
		this._store.add(this._modelService.onModelLanguageChanged(() => this._scheduleRebuild('model-language-changed')));
		this._scheduleRebuild('startup');
	}

	dispose(): void {
		if (this._rebuildTimer) {
			clearTimeout(this._rebuildTimer);
			this._rebuildTimer = null;
		}
		this._store.dispose();
	}

	async getAIName(): Promise<string | undefined> {
		return 'Void AI Search';
	}

	private _cosineSimilarity(a: number[], b: number[]): number {
		let dot = 0;
		let magA = 0;
		let magB = 0;
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i += 1) {
			dot += a[i] * b[i];
			magA += a[i] * a[i];
			magB += b[i] * b[i];
		}
		if (magA === 0 || magB === 0) return 0;
		return dot / (Math.sqrt(magA) * Math.sqrt(magB));
	}

	private _scoreWithSymbolBoost(baseScore: number, query: string, symbolNames: string[]): number {
		const q = query.toLowerCase();
		const symbolHit = symbolNames.some(name => name.toLowerCase().includes(q));
		return symbolHit ? baseScore + 0.2 : baseScore;
	}

	private async _ensureEmbeddingsForChunks(
		chunks: {
			id: string;
			uri: string;
			startLine: number;
			endLine: number;
			content: string;
			symbolNames: string[];
		}[],
		token: CancellationToken
	): Promise<void> {
		const uncachedChunks = chunks.filter(c => !this._embeddingByChunkId.has(c.id));
		const BATCH_SIZE = 16;

		for (let i = 0; i < uncachedChunks.length; i += BATCH_SIZE) {
			if (token.isCancellationRequested) {
				return;
			}

			const batch = uncachedChunks.slice(i, i + BATCH_SIZE);
			const embeddings = await this._aiEmbeddingVectorService.getEmbeddingVector(
				batch.map(c => c.content.slice(0, 4000)),
				token
			) as number[][];

			for (let j = 0; j < batch.length; j += 1) {
				this._embeddingByChunkId.set(batch[j].id, embeddings[j]);
			}
		}
	}

	private async _buildIndex(token: CancellationToken | undefined) {
		if (this._indexCache) {
			return this._indexCache.chunks;
		}

		const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
		const allUris = (await Promise.all(
			workspaceFolders.map(folder => this._directoryStrService.getAllURIsInDirectory(folder.uri, { maxResults: 800 }))
		)).flat();

		const fileUris = allUris.filter(uri => this._shouldIndexUri(uri)).slice(0, 500);

		const chunks: {
			id: string;
			uri: string;
			startLine: number;
			endLine: number;
			content: string;
			symbolNames: string[];
		}[] = [];

		for (const uri of fileUris) {
			if (token?.isCancellationRequested) break;
			const { model } = await this._voidModelService.getModelSafe(uri);
			if (!model) continue;
			const lineCount = model.getLineCount();
			if (lineCount === 0) continue;

			const providers = this._languageFeaturesService.documentSymbolProvider.ordered(model);
			const symbols = [];
			for (const provider of providers) {
				try {
					const result = await provider.provideDocumentSymbols(model, token ?? CancellationToken.None);
					if (result?.length) {
						symbols.push(...result);
						break;
					}
				} catch {
					// ignore provider errors for indexing
				}
			}

			const symbolChunks = symbols
				.filter(sym => sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method || sym.kind === SymbolKind.Class || sym.kind === SymbolKind.Interface)
				.slice(0, 120)
				.map(sym => {
					const start = sym.range.startLineNumber;
					const end = Math.min(sym.range.endLineNumber, start + 80);
					const block = model.getValueInRange({
						startLineNumber: start,
						startColumn: 1,
						endLineNumber: end,
						endColumn: model.getLineMaxColumn(end)
					});
					return {
						id: `${uri.fsPath}:${start}-${end}`,
						uri: uri.fsPath,
						startLine: start,
						endLine: end,
						content: `Symbol: ${sym.name}\n${block}`,
						symbolNames: [sym.name]
					};
				});

			// fallback sliding windows for files with missing symbols
			if (symbolChunks.length === 0) {
				for (let start = 1; start <= lineCount; start += 40) {
					const end = Math.min(lineCount, start + 80);
					const block = model.getValueInRange({
						startLineNumber: start,
						startColumn: 1,
						endLineNumber: end,
						endColumn: model.getLineMaxColumn(end)
					});
					chunks.push({
						id: `${uri.fsPath}:${start}-${end}`,
						uri: uri.fsPath,
						startLine: start,
						endLine: end,
						content: block,
						symbolNames: [],
					});
				}
			} else {
				chunks.push(...symbolChunks);
			}
		}

		this._indexCache = { chunks };
		this._isIndexReady = true;
		return chunks;
	}

	private _shouldIndexUri(uri: URI): boolean {
		const normalizedPath = uri.fsPath.toLowerCase().replace(/\\/g, '/');
		const pathSegments = normalizedPath.split('/').filter(Boolean);

		if (pathSegments.some(segment => VoidAiSearchProvider._excludedPathSegments.has(segment))) {
			return false;
		}

		return (
			!normalizedPath.endsWith('.png') &&
			!normalizedPath.endsWith('.jpg') &&
			!normalizedPath.endsWith('.jpeg') &&
			!normalizedPath.endsWith('.gif') &&
			!normalizedPath.endsWith('.svg') &&
			!normalizedPath.endsWith('.webp') &&
			!normalizedPath.endsWith('.md') &&
			!normalizedPath.endsWith('.mdx') &&
			!normalizedPath.endsWith('.txt') &&
			!normalizedPath.endsWith('.rst') &&
			!normalizedPath.endsWith('.rtf') &&
			!normalizedPath.endsWith('.pdf') &&
			!normalizedPath.endsWith('.html') &&
			!normalizedPath.endsWith('.htm') &&
			!normalizedPath.endsWith('.lock') &&
			!normalizedPath.endsWith('package-lock.json') &&
			!normalizedPath.endsWith('pnpm-lock.yaml') &&
			!normalizedPath.endsWith('yarn.lock') &&
			!normalizedPath.endsWith('bun.lockb') &&
			!normalizedPath.endsWith('.min.js') &&
			!normalizedPath.endsWith('.min.css')
		);
	}

	private _scheduleRebuild(reason: string) {
		if (this._rebuildTimer) {
			clearTimeout(this._rebuildTimer);
		}
		this._rebuildTimer = setTimeout(() => {
			this._rebuildTimer = null;
			void this._ensureBackgroundIndex(reason);
		}, reason === 'startup' ? 50 : 800);
	}

	private async _ensureBackgroundIndex(reason: string): Promise<void> {
		if (this._isBuildingIndex) return this._backgroundBuildPromise ?? Promise.resolve();
		this._isBuildingIndex = true;
		this._isIndexReady = false;
		this._indexCache = null;
		this._embeddingByChunkId.clear();
		this._backgroundBuildPromise = (async () => {
			try {
				console.log(`VoidAiSearchProvider: background index rebuild started (${reason})`);
				const chunks = await this._buildIndex(CancellationToken.None);
				if (chunks.length > 0 && this._aiEmbeddingVectorService.isEnabled()) {
					// Warm a sizeable portion of embeddings upfront for "always-ready" behavior.
					const warmBatch = chunks.slice(0, 128);
					await this._ensureEmbeddingsForChunks(warmBatch, CancellationToken.None);
				}
				this._isIndexReady = true;
				console.log(`VoidAiSearchProvider: background index rebuild done (${reason}), chunks=${chunks.length}, warmed=${this._embeddingByChunkId.size}`);
			} catch (e) {
				console.error('VoidAiSearchProvider: background index rebuild failed', e);
			} finally {
				this._isBuildingIndex = false;
			}
		})();
		return this._backgroundBuildPromise;
	}

	async textSearch(query: ITextQuery | IAITextQuery, onProgress?: (p: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
		if (!this._aiEmbeddingVectorService.isEnabled()) {
			return { results: [], limitHit: false, messages: [{ type: 1, text: 'Void AI Search disabled: no embedding provider.', trusted: false }] };
		}
		const queryText = typeof (query as any).contentPattern === 'string'
			? (query as any).contentPattern
			: (query as any).contentPattern?.pattern ?? '';
		if (!queryText.trim()) {
			return { results: [], limitHit: false, messages: [] };
		}

		// Ensure background indexing is always warm, but still block for first query.
		if (!this._isIndexReady) {
			await this._ensureBackgroundIndex('query-triggered');
		}

		console.log('VoidAiSearchProvider: building/searching index for:', queryText);
		const chunks = await this._buildIndex(token);
		if (chunks.length === 0) {
			return { results: [], limitHit: false, messages: [{ type: 1, text: 'Void AI Search: no indexable chunks found.', trusted: false }] };
		}

		const queryEmbedding = await this._aiEmbeddingVectorService.getEmbeddingVector(queryText, token ?? CancellationToken.None) as number[];
		await this._ensureEmbeddingsForChunks(chunks, token ?? CancellationToken.None);

		const scored = chunks
			.map(chunk => {
				const embedding = this._embeddingByChunkId.get(chunk.id);
				if (!embedding) return null;
				const base = this._cosineSimilarity(queryEmbedding, embedding);
				const score = this._scoreWithSymbolBoost(base, queryText, chunk.symbolNames);
				return { chunk, score };
			})
			.filter(Boolean)
			.sort((a, b) => b!.score - a!.score)
			.slice(0, 20) as { chunk: (typeof chunks)[number], score: number }[];

		const byFile = new Map<string, FileMatch>();
		for (const { chunk } of scored) {
			const fileUri = URI.file(chunk.uri);
			let fileMatch = byFile.get(chunk.uri);
			if (!fileMatch) {
				fileMatch = new FileMatch(fileUri);
				fileMatch.results = [];
				byFile.set(chunk.uri, fileMatch);
			}
			const preview = chunk.content.slice(0, 2500);
			const range = new SearchRange(chunk.startLine, 1, chunk.endLine, 1);
			(fileMatch.results as any).push(new TextSearchMatch(preview, range));
			onProgress?.(fileMatch);
		}

		return {
			results: [...byFile.values()],
			limitHit: false,
			messages: [{ type: 1, text: `Void AI Search indexed ${chunks.length} chunks and returned ${scored.length} matches.`, trusted: false }]
		};
	}

	async fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
		return {
			results: [],
			limitHit: false,
			messages: []
		};
	}

	async clearCache(cacheKey: string): Promise<void> {
		this._indexCache = null;
		this._isIndexReady = false;
		this._embeddingByChunkId.clear();
	}

}

registerSingleton(IVoidAiSearchProvider, VoidAiSearchProvider, InstantiationType.Eager);

class VoidAiSearchWorkbenchContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voidAiSearchProvider';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		instantiationService.createInstance(VoidAiSearchProvider);
	}
}

registerWorkbenchContribution2(VoidAiSearchWorkbenchContribution.ID, VoidAiSearchWorkbenchContribution, WorkbenchPhase.BlockRestore);
