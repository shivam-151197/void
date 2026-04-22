import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IVoidIndexService, IVoidIndexMainService, IndexedSymbol } from '../../common/index/indexServiceTypes.js';
import { ITreeSitterParserService } from '../../../../../editor/common/services/treeSitterParserService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { hashAsync } from '../../../../../base/common/hash.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IAiEmbeddingVectorService } from '../../../../services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';

import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';

export class VoidIndexService extends Disposable implements IVoidIndexService, IWorkbenchContribution {
	readonly _serviceBrand: undefined;
	private readonly _mainService: IVoidIndexMainService;

	constructor(
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@ITreeSitterParserService private readonly _treeSitterService: ITreeSitterParserService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IAiEmbeddingVectorService private readonly _aiEmbeddingVectorService: IAiEmbeddingVectorService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		console.log('[VoidIndexService] Instantiated');
		this._mainService = ProxyChannel.toService<IVoidIndexMainService>(this._mainProcessService.getChannel('void-channel-index'));

		// Register file change listener
		this._register(this._textFileService.files.onDidSave(e => {
			console.log(`[VoidIndexService] File saved: ${e.model.resource.toString()}`);
			if (this._isIndexable(e.model.resource)) {
				this.reindexFile(e.model.resource);
			}
		}));

		// Register workspace change listener
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => {
			console.log('[VoidIndexService] Workspace folders changed, re-indexing workspace');
			this.indexWorkspace();
		}));

		// Start initial indexing in background
		console.log('[VoidIndexService] Triggering initial workspace indexing');
		this.indexWorkspace();
	}

	async indexWorkspace(): Promise<void> {
		const folders = this._contextService.getWorkspace().folders;
		console.log(`[VoidIndexService] indexWorkspace: found ${folders.length} folders: ${folders.map(f => f.uri.toString()).join(', ')}`);
		for (const folder of folders) {
			console.log(`[VoidIndexService] Indexing folder: ${folder.uri.toString()}`);
			this._indexFolder(folder.uri).catch((e) => { console.error(`[VoidIndexService] Folder indexing failed: ${folder.uri.toString()}`, e); });
		}
	}

	private async _indexFolder(folderUri: URI): Promise<void> {
		const result = await this._fileService.resolve(folderUri);
		if (result.children) {
			// console.log(`[VoidIndexService] _indexFolder: ${folderUri.toString()} has ${result.children.length} children`);
			for (const child of result.children) {
				if (child.isDirectory) {
					await this._indexFolder(child.resource);
				} else if (this._isIndexable(child.resource)) {
					await this.reindexFile(child.resource);
				}
			}
		}
	}

	private _isIndexable(uri: URI): boolean {
		const ext = uri.path.split('.').pop()?.toLowerCase();
		return ['ts', 'js', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'hpp', 'java', 'rs', 'go'].includes(ext || '');
	}

	async reindexFile(uri: URI): Promise<void> {
		console.log(`[VoidIndexService] Reindexing file: ${uri.toString()}`);
		try {
			const stat = await this._fileService.stat(uri);
			if (stat.size > 1024 * 1024) { // 1MB limit for indexing
				console.log(`[VoidIndexService] Skipping ${uri.toString()} due to size: ${stat.size}`);
				return;
			}

			const contentResult = await this._textFileService.read(uri);
			const content = contentResult.value;
			const hash = await hashAsync(content);

			const prevIndex = await this._mainService.getFileIndex(uri.toString());
			if (prevIndex && prevIndex.hash === hash) {
				console.log(`[VoidIndexService] Skipping ${uri.toString()} - already indexed with same hash.`);
				return; // Up to date
			}

			const symbols = await this._extractSymbols(uri, content);
			console.log(`[VoidIndexService] Extracted ${symbols.length} symbols from ${uri.toString()}. Updating main index.`);
			await this._mainService.updateFileIndex(uri.toString(), hash, symbols);
		} catch (e) {
			console.error(`[VoidIndexService] Failed to index file ${uri.toString()}:`, e);
		}
	}

	private async _extractSymbols(uri: URI, content: string): Promise<IndexedSymbol[]> {
		const languageId = this._getLanguageId(uri);
		if (!languageId) {
			console.warn(`[VoidIndexService] Unknown language for ${uri.toString()}`);
			return [];
		}
		console.log(`[VoidIndexService] Extracting symbols for ${uri.toString()} (language: ${languageId})`);
		const tree = await this._treeSitterService.getTree(content, languageId);
		if (!tree) {
			console.warn(`[VoidIndexService] Could not get tree for ${uri.toString()}`);
			return [];
		}

		const symbols: IndexedSymbol[] = [];
		const walk = (node: any) => {
			if (this._isInteresting(node)) {
				symbols.push({
					id: `${uri.toString()}:${node.startIndex}`,
					uri: uri,
					name: this._getNodeName(node, content),
					type: node.type,
					range: {
						startLine: node.startPosition.row + 1,
						startColumn: node.startPosition.column + 1,
						endLine: node.endPosition.row + 1,
						endColumn: node.endPosition.column + 1,
					},
					text: content.substring(node.startIndex, node.endIndex),
				});
			}
			for (let i = 0; i < node.childCount; i++) {
				walk(node.child(i));
			}
		};

		walk(tree.rootNode);
		console.log(`[VoidIndexService] Found ${symbols.length} interesting nodes in ${uri.toString()}`);

		// Get embeddings for symbols
		for (const symbol of symbols) {
			try {
				console.log(`[VoidIndexService] Getting embedding for symbol: ${symbol.name}`);
				const embeddings = await this._aiEmbeddingVectorService.getEmbeddingVector(symbol.text, CancellationToken.None);
				symbol.embedding = embeddings;
			} catch (e) {
				console.error(`[VoidIndexService] Embedding failed for ${symbol.name}:`, e);
			}
		}

		return symbols;
	}

	private _isInteresting(node: any): boolean {
		const types = [
			'function_declaration', 'class_declaration', 'method_definition',
			'function_item', 'arrow_function', 'interface_declaration',
			'enum_declaration', 'struct_specifier', 'class_specifier',
			'method_declaration', 'function_definition', 'class_definition',
			'module_definition', 'protocol_declaration', 'impl_definition'
		];
		return types.includes(node.type);
	}

	private _getNodeName(node: any, content: string): string {
		const nameNode = node.childForFieldName('name') || node.childForFieldName('declarator');
		if (nameNode) {
			return content.substring(nameNode.startIndex, nameNode.endIndex);
		}
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child.type === 'identifier' || child.type === 'type_identifier') {
				return content.substring(child.startIndex, child.endIndex);
			}
		}
		return 'anonymous';
	}

	private _getLanguageId(uri: URI): string | undefined {
		const ext = uri.path.split('.').pop()?.toLowerCase();
		switch (ext) {
			case 'ts': return 'typescript';
			case 'tsx': return 'typescript';
			case 'js': return 'javascript';
			case 'jsx': return 'javascript';
			case 'py': return 'python';
			case 'java': return 'java';
			case 'go': return 'go';
			case 'rs': return 'rust';
			case 'cpp': return 'cpp';
			case 'hpp': return 'cpp';
			case 'c': return 'c';
			case 'h': return 'c';
			case 'proto': return 'protobuf';
			case 'rb': return 'ruby';
			case 'php': return 'php';
			case 'rust': return 'rust';
			default: return undefined;
		}
	}

	async searchSymbols(query: string): Promise<IndexedSymbol[]> {
		return this._mainService.searchSymbols(query);
	}

	async semanticSearch(query: string, limit: number = 10): Promise<IndexedSymbol[]> {
		console.log(`[VoidIndexService] semanticSearch for: ${query}`);
		try {
			const queryEmbedding = await this._aiEmbeddingVectorService.getEmbeddingVector(query, CancellationToken.None);
			return this._mainService.semanticSearch(queryEmbedding, limit);
		} catch (e) {
			console.error('[VoidIndexService] semanticSearch failed:', e);
			return [];
		}
	}

	async getSymbolsForFile(uri: URI): Promise<IndexedSymbol[]> {
		return this._mainService.getSymbols(uri.toString());
	}
}

registerSingleton(IVoidIndexService, VoidIndexService, InstantiationType.Eager);

class VoidIndexWorkbenchContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voidIndex';
	constructor(@IVoidIndexService _indexService: IVoidIndexService) { }
}

registerWorkbenchContribution2(VoidIndexWorkbenchContribution.ID, VoidIndexWorkbenchContribution, WorkbenchPhase.AfterRestored);

