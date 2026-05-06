/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IVoidIndexService = createDecorator<IVoidIndexService>('voidIndexService');
export type VoidIndexQueryIntent = 'ownership' | 'references' | 'definition' | 'callers';
export type IndexedNodeRole = 'file' | 'definition' | 'call' | 'import' | 'export' | 'reference' | 'container';
export type IndexedEdgeType = 'contains' | 'defines' | 'calls' | 'imports' | 'references';

export interface RankedDirectory {
	uri: URI;
	score: number;
	reason: string;
}

export interface IVoidIndexService {
	readonly _serviceBrand: undefined;
	indexWorkspace(): Promise<void>;
	reindexFile(uri: URI): Promise<void>;
	searchSymbols(query: string): Promise<IndexedSymbol[]>;
	searchCallers(query: string): Promise<IndexedSymbol[]>;
	semanticSearch(query: string, limit?: number): Promise<IndexedSymbol[]>;
	getSymbolsForFile(uri: URI): Promise<IndexedSymbol[]>;
	getContextNeighborhoods(query: string, options?: { intent?: VoidIndexQueryIntent; limit?: number }): Promise<IndexedContextNeighborhood[]>;
	searchDirectories(query: string, limit?: number): Promise<RankedDirectory[]>;
}

export interface IVoidIndexMainService {
	readonly _serviceBrand: undefined;
	updateFileIndex(uri: string, hash: string, graph: IndexedFileGraph): Promise<void>;
	getFileIndex(uri: string): Promise<FileIndexInfo | undefined>;
	getSymbols(uri: string): Promise<IndexedSymbol[]>;
	searchSymbols(query: string): Promise<IndexedSymbol[]>;
	searchCallers(query: string): Promise<IndexedSymbol[]>;
	semanticSearch(queryEmbedding: number[], limit?: number): Promise<IndexedSymbol[]>;
	getContextNeighborhoods(query: string, options?: { intent?: VoidIndexQueryIntent; limit?: number }): Promise<IndexedContextNeighborhood[]>;
	searchDirectories(query: string, limit?: number): Promise<RankedDirectory[]>;
	exportGraph(workspaceUri: string): Promise<void>;
}
export const IVoidIndexMainService = createDecorator<IVoidIndexMainService>('voidIndexMainService');

export interface IndexedSymbol {
	id: string;
	uri: URI;
	name: string;
	type: string; // 'function', 'class', 'method', etc.
	range: {
		startLine: number;
		startColumn: number;
		endLine: number;
		endColumn: number;
	};
	text: string;
	embedding?: number[];
	role?: IndexedNodeRole;
	parentId?: string | null;
	metadata?: Record<string, string>;
}

export interface IndexedEdge {
	id: string;
	sourceId: string;
	sourceUri: URI;
	targetId?: string | null;
	targetUri?: URI | null;
	targetName?: string | null;
	type: IndexedEdgeType;
	metadata?: Record<string, string>;
}

export interface IndexedFileGraph {
	nodes: IndexedSymbol[];
	edges: IndexedEdge[];
}

export interface IndexedContextNeighborhood {
	uri: URI;
	anchorNodes: IndexedSymbol[];
	relatedNodes: IndexedSymbol[];
	edges: IndexedEdge[];
	score: number;
}

export interface FileIndexInfo {
	uri: URI;
	hash: string;
	lastIndexed: number;
}
