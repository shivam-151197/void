import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { hashAsync } from '../../../../../base/common/hash.js';
import { ITreeSitterParserService } from '../../../../../editor/common/services/treeSitterParserService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IndexedContextNeighborhood, IndexedEdge, IndexedFileGraph, IndexedNodeRole, IndexedSymbol, IVoidIndexMainService, IVoidIndexService, VoidIndexQueryIntent, RankedDirectory } from '../../common/index/indexServiceTypes.js';

export class VoidIndexService extends Disposable implements IVoidIndexService, IWorkbenchContribution {
	readonly _serviceBrand: undefined;
	private readonly _mainService: IVoidIndexMainService;
	private _indexRunId = 0;
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
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@ITreeSitterParserService private readonly _treeSitterService: ITreeSitterParserService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._mainService = ProxyChannel.toService<IVoidIndexMainService>(this._mainProcessService.getChannel('void-channel-index'));

		this._register(this._textFileService.files.onDidSave(e => {
			if (this._isIndexable(e.model.resource)) {
				this.reindexFile(e.model.resource);
			}
		}));

		this._register(this._contextService.onDidChangeWorkspaceFolders(() => {
			this.indexWorkspace();
		}));

		this.indexWorkspace();
	}

	async indexWorkspace(): Promise<void> {
		const runId = ++this._indexRunId;
		const startedAt = Date.now();
		const folders = this._contextService.getWorkspace().folders;
		console.log(`[Void][indexWorkspace][run=${runId}] starting folders=${folders.map(folder => folder.uri.toString()).join(', ') || '(none)'}`);
		const counts = await Promise.all(folders.map(folder =>
			this._indexFolder(folder.uri).catch(error => {
				console.error(`[Void][indexWorkspace][run=${runId}] folder failed ${folder.uri.toString()}`, error);
				return 0;
			})
		));
		const indexedFiles = counts.reduce((sum, count) => sum + count, 0);
		console.log(`[Void][indexWorkspace][run=${runId}] completed indexedFiles=${indexedFiles} durationMs=${Date.now() - startedAt}`);
	}

	private async _indexFolder(folderUri: URI): Promise<number> {
		const result = await this._fileService.resolve(folderUri);
		if (!result.children) {
			return 0;
		}
		let indexedFiles = 0;
		for (const child of result.children) {
			if (child.isDirectory && !this._isExcluded(child.resource)) {
				indexedFiles += await this._indexFolder(child.resource);
			} else if (this._isIndexable(child.resource)) {
				await this.reindexFile(child.resource);
				indexedFiles += 1;
			}
		}
		return indexedFiles;
	}

	private _isIndexable(uri: URI): boolean {
		if (this._isExcluded(uri)) {
			return false;
		}
		const ext = uri.path.split('.').pop()?.toLowerCase();
		return ['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'hpp', 'proto', 'yml', 'yaml', 'json', 'sql', 'rb', 'php'].includes(ext || '');
	}

	private _isExcluded(uri: URI): boolean {
		const normalizedPath = uri.fsPath.toLowerCase().replace(/\\/g, '/');
		const pathSegments = normalizedPath.split('/').filter(Boolean);
		return pathSegments.some(segment => VoidIndexService._excludedPathSegments.has(segment));
	}

	async reindexFile(uri: URI): Promise<void> {
		try {
			const stat = await this._fileService.stat(uri);
			if (stat.size > 1024 * 1024) {
				return;
			}

			const contentResult = await this._textFileService.read(uri);
			const content = contentResult.value;
			const hash = await hashAsync(content);
			const prevIndex = await this._mainService.getFileIndex(uri.toString());
			if (prevIndex && prevIndex.hash === hash) {
				return;
			}

			const graph = await this._extractGraph(uri, content);
			await this._mainService.updateFileIndex(uri.toString(), hash, graph);
		} catch (error) {
			console.error(`[VoidIndexService] Failed to index file ${uri.toString()}:`, error);
		}
	}

	private async _extractGraph(uri: URI, content: string): Promise<IndexedFileGraph> {
		const languageId = this._getLanguageId(uri);
		if (!languageId) {
			return { nodes: [], edges: [] };
		}

		const tree = await this._treeSitterService.getTree(content, languageId);
		if (!tree) {
			return { nodes: [], edges: [] };
		}

		const fileNodeId = `${uri.toString()}:file`;
		const fileNode: IndexedSymbol = {
			id: fileNodeId,
			uri,
			name: uri.path.split('/').pop() ?? uri.toString(),
			type: 'file',
			role: 'file',
			range: { startLine: 1, startColumn: 1, endLine: Math.max(1, content.split('\n').length), endColumn: 1 },
			text: '',
		};

		const nodes: IndexedSymbol[] = [fileNode];
		const edges: IndexedEdge[] = [];
		const definitionNames = new Set<string>();

		const walk = (node: any, parentInterestingId: string | null) => {
			let currentInterestingId = parentInterestingId;
			if (this._isInteresting(node)) {
				const role = this._getNodeRole(node.type);
				const indexedNode: IndexedSymbol = {
					id: `${uri.toString()}:${node.startIndex}`,
					uri,
					name: this._getNodeName(node, content),
					type: node.type,
					role,
					parentId: parentInterestingId ?? fileNodeId,
					range: {
						startLine: node.startPosition.row + 1,
						startColumn: node.startPosition.column + 1,
						endLine: node.endPosition.row + 1,
						endColumn: node.endPosition.column + 1,
					},
					text: content.substring(node.startIndex, node.endIndex),
				};
				nodes.push(indexedNode);
				currentInterestingId = indexedNode.id;
				if (role === 'definition' || role === 'container') {
					definitionNames.add(indexedNode.name);
				}

				edges.push({
					id: `${indexedNode.id}:contains`,
					sourceId: indexedNode.parentId ?? fileNodeId,
					sourceUri: uri,
					targetId: indexedNode.id,
					targetUri: uri,
					targetName: indexedNode.name,
					type: indexedNode.parentId === fileNodeId ? 'defines' : 'contains',
				});

				if (role === 'call') {
					edges.push({
						id: `${indexedNode.id}:calls:${indexedNode.name}`,
						sourceId: indexedNode.parentId ?? indexedNode.id,
						sourceUri: uri,
						targetName: indexedNode.name,
						type: 'calls',
						metadata: { callee: indexedNode.name },
					});
				}
			}

			for (let i = 0; i < node.childCount; i++) {
				walk(node.child(i), currentInterestingId);
			}
		};

		walk(tree.rootNode, fileNodeId);
		this._appendImportNodes(uri, content, fileNodeId, nodes, edges);
		this._appendReferenceEdges(uri, nodes, edges, definitionNames);

		return { nodes, edges };
	}

	private _appendImportNodes(uri: URI, content: string, fileNodeId: string, nodes: IndexedSymbol[], edges: IndexedEdge[]): void {
		const importRegex = /\b(?:import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\()\s*['"]([^'"]+)['"]/g;
		for (const match of content.matchAll(importRegex)) {
			const specifier = match[1];
			const startIndex = match.index ?? 0;
			const targetName = this._basenameSpecifier(specifier);
			const importNodeId = `${uri.toString()}:import:${startIndex}`;
			nodes.push({
				id: importNodeId,
				uri,
				name: targetName,
				type: 'import_statement',
				role: 'import',
				parentId: fileNodeId,
				range: this._offsetToRange(content, startIndex, startIndex + match[0].length),
				text: match[0],
				metadata: { specifier },
			});
			edges.push({
				id: `${importNodeId}:imports:${specifier}`,
				sourceId: importNodeId,
				sourceUri: uri,
				targetName,
				targetUri: this._resolveImportTargetUri(uri, specifier),
				type: 'imports',
				metadata: { specifier },
			});
		}
	}

	private _appendReferenceEdges(uri: URI, nodes: IndexedSymbol[], edges: IndexedEdge[], definitionNames: Set<string>): void {
		const referenceTargets = [...definitionNames].filter(Boolean);
		if (referenceTargets.length === 0) {
			return;
		}

		for (const node of nodes) {
			if (!node.role || (node.role !== 'definition' && node.role !== 'container')) {
				continue;
			}
			const identifiers = new Set((node.text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).filter(token => token !== node.name));
			for (const identifier of identifiers) {
				if (!referenceTargets.includes(identifier)) {
					continue;
				}
				edges.push({
					id: `${node.id}:references:${identifier}`,
					sourceId: node.id,
					sourceUri: uri,
					targetName: identifier,
					type: 'references',
				});
			}
		}
	}

	private _getNodeRole(type: string): IndexedNodeRole {
		if (type === 'call_expression' || type === 'new_expression' || type === 'method_invocation' || type === 'call') {
			return 'call';
		}
		if (type.includes('class') || type.includes('module') || type.includes('impl')) {
			return 'container';
		}
		return 'definition';
	}

	private _isInteresting(node: any): boolean {
		const types = [
			'function_declaration', 'class_declaration', 'method_definition',
			'function_item', 'arrow_function', 'interface_declaration',
			'enum_declaration', 'struct_specifier', 'class_specifier',
			'method_declaration', 'function_definition', 'class_definition',
			'module_definition', 'protocol_declaration', 'impl_definition',
			'call_expression', 'new_expression', 'method_invocation', 'call'
		];
		return types.includes(node.type);
	}

	private _getNodeName(node: any, content: string): string {
		if (node.type === 'call_expression' || node.type === 'new_expression' || node.type === 'method_invocation' || node.type === 'call') {
			return this._getCallNodeName(node, content);
		}
		const nameNode = node.childForFieldName('name') || node.childForFieldName('declarator');
		if (nameNode) {
			return content.substring(nameNode.startIndex, nameNode.endIndex);
		}
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier') {
				return content.substring(child.startIndex, child.endIndex);
			}
		}
		return 'anonymous';
	}

	private _getCallNodeName(node: any, content: string): string {
		const functionNode = node.childForFieldName('function') || node.childForFieldName('name') || node.childForFieldName('callee');
		const targetNode = functionNode ?? node.firstChild;
		if (!targetNode) {
			return 'anonymous_call';
		}

		const extractLastIdentifier = (candidate: any): string | null => {
			if (!candidate) return null;
			if (candidate.type === 'identifier' || candidate.type === 'property_identifier' || candidate.type === 'type_identifier') {
				return content.substring(candidate.startIndex, candidate.endIndex);
			}
			for (let i = candidate.childCount - 1; i >= 0; i--) {
				const child = candidate.child(i);
				const name = extractLastIdentifier(child);
				if (name) {
					return name;
				}
			}
			return null;
		};

		return extractLastIdentifier(targetNode) ?? (content.substring(targetNode.startIndex, targetNode.endIndex).trim() || 'anonymous_call');
	}

	private _basenameSpecifier(specifier: string): string {
		const normalized = specifier.replace(/\\/g, '/').replace(/\.[^.]+$/, '');
		const basename = normalized.split('/').pop() ?? normalized;
		return basename || specifier;
	}

	private _resolveImportTargetUri(uri: URI, specifier: string): URI | undefined {
		if (!specifier.startsWith('.')) {
			return undefined;
		}
		const segments = uri.path.split('/').filter(Boolean);
		segments.pop();
		for (const part of specifier.split('/')) {
			if (!part || part === '.') {
				continue;
			}
			if (part === '..') {
				segments.pop();
			} else {
				segments.push(part);
			}
		}
		const path = `/${segments.join('/')}`;
		return uri.with({ path });
	}

	private _offsetToRange(content: string, startOffset: number, endOffset: number): IndexedSymbol['range'] {
		const before = content.slice(0, startOffset);
		const startLine = before.split('\n').length;
		const startColumn = startOffset - before.lastIndexOf('\n');
		const segment = content.slice(startOffset, endOffset);
		const lines = segment.split('\n');
		const endLine = startLine + lines.length - 1;
		const endColumn = lines.length === 1 ? startColumn + segment.length : (lines.at(-1)?.length ?? 0) + 1;
		return { startLine, startColumn, endLine, endColumn };
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
			default: return undefined;
		}
	}

	async searchSymbols(query: string): Promise<IndexedSymbol[]> {
		return this._mainService.searchSymbols(query);
	}

	async searchCallers(query: string): Promise<IndexedSymbol[]> {
		return this._mainService.searchCallers(query);
	}

	async semanticSearch(query: string, limit: number = 10): Promise<IndexedSymbol[]> {
		try {
			const symbols = await this.searchSymbols(query);
			return symbols.slice(0, limit);
		} catch (error) {
			console.error('[VoidIndexService] semanticSearch (AST) failed:', error);
			return [];
		}
	}

	async getSymbolsForFile(uri: URI): Promise<IndexedSymbol[]> {
		return this._mainService.getSymbols(uri.toString());
	}

	async getContextNeighborhoods(query: string, options?: { intent?: VoidIndexQueryIntent; limit?: number }): Promise<IndexedContextNeighborhood[]> {
		return this._mainService.getContextNeighborhoods(query, options);
	}

	async searchDirectories(query: string, limit?: number): Promise<RankedDirectory[]> {
		return this._mainService.searchDirectories(query, limit);
	}
}

registerSingleton(IVoidIndexService, VoidIndexService, InstantiationType.Eager);

class VoidIndexWorkbenchContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voidIndex';
	constructor(@IVoidIndexService _indexService: IVoidIndexService) { }
}

registerWorkbenchContribution2(VoidIndexWorkbenchContribution.ID, VoidIndexWorkbenchContribution, WorkbenchPhase.AfterRestored);
