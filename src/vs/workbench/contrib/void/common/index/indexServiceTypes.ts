/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IVoidIndexService = createDecorator<IVoidIndexService>('voidIndexService');

export interface IVoidIndexService {
	readonly _serviceBrand: undefined;
	indexWorkspace(): Promise<void>;
	reindexFile(uri: URI): Promise<void>;
	searchSymbols(query: string): Promise<IndexedSymbol[]>;
	semanticSearch(query: string, limit?: number): Promise<IndexedSymbol[]>;
	getSymbolsForFile(uri: URI): Promise<IndexedSymbol[]>;
}

export interface IVoidIndexMainService {
	readonly _serviceBrand: undefined;
	updateFileIndex(uri: string, hash: string, symbols: IndexedSymbol[]): Promise<void>;
	getFileIndex(uri: string): Promise<FileIndexInfo | undefined>;
	getSymbols(uri: string): Promise<IndexedSymbol[]>;
	searchSymbols(query: string): Promise<IndexedSymbol[]>;
	semanticSearch(queryEmbedding: number[], limit?: number): Promise<IndexedSymbol[]>;
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
}

export interface FileIndexInfo {
	uri: URI;
	hash: string;
	lastIndexed: number;
}
