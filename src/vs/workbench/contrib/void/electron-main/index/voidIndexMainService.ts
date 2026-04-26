/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IndexedContextNeighborhood, IndexedEdge, IndexedFileGraph, IndexedSymbol, FileIndexInfo, IVoidIndexMainService, VoidIndexQueryIntent } from '../../common/index/indexServiceTypes.js';

export class VoidIndexMainService implements IVoidIndexMainService {
	readonly _serviceBrand: undefined;
	private _db: Promise<Database> | undefined;
	private readonly _dbPath: string;

	constructor(
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
	) {
		this._dbPath = join(this._environmentMainService.userDataPath, 'void_indexing.db');
	}

	private async _getDb(): Promise<Database> {
		if (this._db) {
			return this._db;
		}

		this._db = (async () => {
			const sqlite3 = (await import('@vscode/sqlite3')).verbose();
			return new Promise<Database>((resolve, reject) => {
				const db = new sqlite3.Database(this._dbPath, (err) => {
					if (err) return reject(err);
					db.serialize(() => {
						db.run('CREATE TABLE IF NOT EXISTS files (uri TEXT PRIMARY KEY, hash TEXT, lastIndexed INTEGER)');
						db.run('CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, uri TEXT, name TEXT, type TEXT, role TEXT, parentId TEXT, metadata TEXT, startLine INTEGER, startColumn INTEGER, endLine INTEGER, endColumn INTEGER, text TEXT, embedding BLOB)');
						db.run('CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, sourceId TEXT, sourceUri TEXT, targetId TEXT, targetUri TEXT, targetName TEXT, type TEXT, metadata TEXT)');
						db.run('CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri)');
						db.run('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)');
						db.run('CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parentId)');
						db.run('CREATE INDEX IF NOT EXISTS idx_edges_source_id ON edges(sourceId)');
						db.run('CREATE INDEX IF NOT EXISTS idx_edges_source_uri ON edges(sourceUri)');
						db.run('CREATE INDEX IF NOT EXISTS idx_edges_target_name ON edges(targetName)');
						resolve(db);
					});
				});
			});
		})();

		return this._db;
	}

	async updateFileIndex(uri: string, hash: string, graph: IndexedFileGraph): Promise<void> {
		console.log(`[VoidIndexMainService] Indexing file: ${uri}, hash: ${hash}, nodes: ${graph.nodes.length}, edges: ${graph.edges.length}`);
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.serialize(() => {
				db.run('BEGIN TRANSACTION');
				db.run('INSERT OR REPLACE INTO files (uri, hash, lastIndexed) VALUES (?, ?, ?)', [uri, hash, Date.now()]);
				db.run('DELETE FROM symbols WHERE uri = ?', [uri]);
				db.run('DELETE FROM edges WHERE sourceUri = ?', [uri]);
				const symbolStmt = db.prepare('INSERT INTO symbols (id, uri, name, type, role, parentId, metadata, startLine, startColumn, endLine, endColumn, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
				for (const symbol of graph.nodes) {
					let embeddingBlob: Buffer | null = null;
					if (symbol.embedding) {
						embeddingBlob = Buffer.from(new Float32Array(symbol.embedding).buffer);
					}
					symbolStmt.run([
						symbol.id,
						uri,
						symbol.name,
						symbol.type,
						symbol.role ?? null,
						symbol.parentId ?? null,
						symbol.metadata ? JSON.stringify(symbol.metadata) : null,
						symbol.range.startLine,
						symbol.range.startColumn,
						symbol.range.endLine,
						symbol.range.endColumn,
						symbol.text,
						embeddingBlob
					]);
				}
				symbolStmt.finalize();

				const edgeStmt = db.prepare('INSERT INTO edges (id, sourceId, sourceUri, targetId, targetUri, targetName, type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
				for (const edge of graph.edges) {
					edgeStmt.run([
						edge.id,
						edge.sourceId,
						edge.sourceUri.toString(),
						edge.targetId ?? null,
						edge.targetUri?.toString() ?? null,
						edge.targetName ?? null,
						edge.type,
						edge.metadata ? JSON.stringify(edge.metadata) : null,
					]);
				}
				edgeStmt.finalize();
				db.run('COMMIT', (err) => {
					if (err) {
						console.error('[VoidIndexMainService] Error committing transaction:', err);
						return reject(err);
					}
					resolve();
				});
			});
		});
	}

	async getFileIndex(uri: string): Promise<FileIndexInfo | undefined> {
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.get('SELECT * FROM files WHERE uri = ?', [uri], (err, row) => {
				if (err) return reject(err);
				if (!row) return resolve(undefined);
				resolve({
					uri: URI.parse((row as any).uri),
					hash: (row as any).hash,
					lastIndexed: (row as any).lastIndexed,
				});
			});
		});
	}

	async getSymbols(uri: string): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return this._all(db, 'SELECT * FROM symbols WHERE uri = ? ORDER BY startLine ASC, startColumn ASC', [uri], row => this._mapRowToSymbol(row));
	}

	async searchSymbols(query: string): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return this._all(db, 'SELECT * FROM symbols WHERE role != ? AND (name LIKE ? OR text LIKE ?) LIMIT 50', ['file', `%${query}%`, `%${query}%`], row => this._mapRowToSymbol(row));
	}

	async searchCallers(query: string): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return this._all(
			db,
			'SELECT * FROM symbols WHERE role = ? AND type IN (?, ?, ?, ?) AND (name LIKE ? OR text LIKE ?) LIMIT 100',
			['call', 'call_expression', 'new_expression', 'method_invocation', 'call', `%${query}%`, `%${query}%`],
			row => this._mapRowToSymbol(row),
		);
	}

	async getContextNeighborhoods(query: string, options?: { intent?: VoidIndexQueryIntent; limit?: number }): Promise<IndexedContextNeighborhood[]> {
		const db = await this._getDb();
		const limit = Math.max(1, Math.min(options?.limit ?? 12, 24));
		const intent = options?.intent ?? 'ownership';
		const queryTerms = this._extractQueryTerms(query).slice(0, 6);
		if (queryTerms.length === 0) {
			return [];
		}

		const anchors = await this._all(
			db,
			this._buildAnchorQuery(queryTerms, limit),
			this._buildAnchorParams(queryTerms),
			row => this._mapRowToSymbol(row),
		);
		if (anchors.length === 0) {
			return [];
		}

		const anchorsByUri = new Map<string, IndexedSymbol[]>();
		for (const anchor of anchors) {
			const key = anchor.uri.toString();
			const list = anchorsByUri.get(key) ?? [];
			list.push(anchor);
			anchorsByUri.set(key, list);
		}

		const neighborhoods: IndexedContextNeighborhood[] = [];
		for (const [uri, anchorNodes] of anchorsByUri) {
			const seenNodeIds = new Set<string>(anchorNodes.map(node => node.id));
			const relatedNodes: IndexedSymbol[] = [];

			for (const anchor of anchorNodes.slice(0, 4)) {
				const parents = await this._collectParentChain(db, anchor, 2);
				for (const parent of parents) {
					if (!seenNodeIds.has(parent.id)) {
						seenNodeIds.add(parent.id);
						relatedNodes.push(parent);
					}
				}
				const children = await this._all(
					db,
					'SELECT * FROM symbols WHERE parentId = ? ORDER BY startLine ASC, startColumn ASC LIMIT 8',
					[anchor.id],
					row => this._mapRowToSymbol(row),
				);
				for (const child of children) {
					if (!seenNodeIds.has(child.id)) {
						seenNodeIds.add(child.id);
						relatedNodes.push(child);
					}
				}
			}

			const nodeIds = [...seenNodeIds];
			const anchorNames = [...new Set(anchorNodes.map(node => node.name.toLowerCase()).filter(Boolean))];
			const outgoingEdges = nodeIds.length > 0
				? await this._all(
					db,
					`SELECT * FROM edges WHERE sourceId IN (${nodeIds.map(() => '?').join(', ')}) LIMIT 40`,
					nodeIds,
					row => this._mapRowToEdge(row),
				)
				: [];
			const incomingEdges = anchorNames.length > 0
				? await this._all(
					db,
					`SELECT * FROM edges WHERE LOWER(targetName) IN (${anchorNames.map(() => '?').join(', ')}) LIMIT 40`,
					anchorNames,
					row => this._mapRowToEdge(row),
				)
				: [];
			const edgeMap = new Map<string, IndexedEdge>();
			for (const edge of [...outgoingEdges, ...incomingEdges]) {
				edgeMap.set(edge.id, edge);
			}
			const edges = [...edgeMap.values()];

			const relatedNames = [...new Set(edges
				.map(edge => edge.targetName?.toLowerCase() ?? '')
				.filter(name => !!name && !anchorNames.includes(name))
			)].slice(0, 10);
			if (relatedNames.length > 0) {
				const namedNodes = await this._all(
					db,
					`SELECT * FROM symbols WHERE LOWER(name) IN (${relatedNames.map(() => '?').join(', ')}) LIMIT 16`,
					relatedNames,
					row => this._mapRowToSymbol(row),
				);
				for (const node of namedNodes) {
					if (!seenNodeIds.has(node.id)) {
						seenNodeIds.add(node.id);
						relatedNodes.push(node);
					}
				}
			}

			neighborhoods.push({
				uri: URI.parse(uri),
				anchorNodes,
				relatedNodes,
				edges,
				score: this._scoreNeighborhood(anchorNodes, relatedNodes, edges, intent, queryTerms),
			});
		}

		return neighborhoods
			.sort((a, b) => {
				if (b.score !== a.score) {
					return b.score - a.score;
				}
				return a.uri.toString().localeCompare(b.uri.toString());
			})
			.slice(0, limit);
	}

	async semanticSearch(queryEmbedding: number[], limit: number = 10): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.all('SELECT * FROM symbols WHERE embedding IS NOT NULL AND role != ?', ['file'], (err, rows) => {
				if (err) return reject(err);
				const symbols = rows.map(row => this._mapRowToSymbol(row));
				const ranked = symbols
					.map(symbol => ({
						symbol,
						score: this._cosineSimilarity(queryEmbedding, symbol.embedding!),
					}))
					.sort((a, b) => b.score - a.score)
					.slice(0, limit)
					.map(item => item.symbol);
				resolve(ranked);
			});
		});
	}

	private _extractQueryTerms(query: string): string[] {
		return [...new Set(
			query
				.toLowerCase()
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.replace(/[_./:-]+/g, ' ')
				.split(/\s+/g)
				.filter(term => term.length >= 3)
		)];
	}

	private _buildAnchorQuery(queryTerms: string[], limit: number): string {
		const clauses = queryTerms.map(() => '(LOWER(name) LIKE ? OR LOWER(text) LIKE ?)');
		const exacts = queryTerms.map(() => '?').join(', ');
		return `
			SELECT * FROM symbols
			WHERE role != 'file' AND (${clauses.join(' OR ')})
			ORDER BY
				CASE
					WHEN LOWER(name) IN (${exacts}) THEN 4
					WHEN role = 'definition' THEN 3
					WHEN role = 'call' THEN 2
					ELSE 1
				END DESC,
				LENGTH(name) ASC,
				startLine ASC
			LIMIT ${limit}
		`;
	}

	private _buildAnchorParams(queryTerms: string[]): string[] {
		const params: string[] = [];
		for (const term of queryTerms) {
			params.push(`%${term}%`, `%${term}%`);
		}
		params.push(...queryTerms);
		return params;
	}

	private async _collectParentChain(db: Database, anchor: IndexedSymbol, depth: number): Promise<IndexedSymbol[]> {
		const chain: IndexedSymbol[] = [];
		let parentId = anchor.parentId ?? null;
		let remaining = depth;
		while (parentId && remaining > 0) {
			const parent = await this._get(db, 'SELECT * FROM symbols WHERE id = ? LIMIT 1', [parentId], row => this._mapRowToSymbol(row));
			if (!parent) {
				break;
			}
			chain.push(parent);
			parentId = parent.parentId ?? null;
			remaining--;
		}
		return chain;
	}

	private _scoreNeighborhood(anchorNodes: IndexedSymbol[], relatedNodes: IndexedSymbol[], edges: IndexedEdge[], intent: VoidIndexQueryIntent, queryTerms: string[]): number {
		let score = 0;
		for (const anchor of anchorNodes) {
			const anchorName = anchor.name.toLowerCase();
			score += queryTerms.filter(term => anchorName === term).length * 24;
			score += queryTerms.filter(term => anchorName.includes(term)).length * 10;
			if (anchor.role === 'definition') {
				score += intent === 'definition' || intent === 'ownership' ? 18 : 6;
			}
			if (anchor.role === 'call') {
				score += intent === 'callers' ? 26 : 8;
			}
		}
		for (const edge of edges) {
			if (edge.type === 'calls') {
				score += intent === 'callers' ? 18 : 6;
			} else if (edge.type === 'imports') {
				score += intent === 'references' ? 12 : 5;
			} else if (edge.type === 'references') {
				score += intent === 'references' ? 10 : 4;
			} else if (edge.type === 'defines') {
				score += intent === 'definition' || intent === 'ownership' ? 10 : 3;
			}
		}
		score += Math.min(relatedNodes.length, 8) * 2;
		return score;
	}

	private _get<T>(db: Database, sql: string, params: unknown[], map: (row: any) => T): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			db.get(sql, params, (err, row) => {
				if (err) return reject(err);
				resolve(row ? map(row) : undefined);
			});
		});
	}

	private _all<T>(db: Database, sql: string, params: unknown[], map: (row: any) => T): Promise<T[]> {
		return new Promise((resolve, reject) => {
			db.all(sql, params, (err, rows) => {
				if (err) return reject(err);
				resolve(rows.map(row => map(row)));
			});
		});
	}

	private _cosineSimilarity(vecA: number[], vecB: number[]): number {
		let dotProduct = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < vecA.length; i++) {
			dotProduct += vecA[i] * vecB[i];
			normA += vecA[i] * vecA[i];
			normB += vecB[i] * vecB[i];
		}
		return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	private _mapRowToSymbol(row: any): IndexedSymbol {
		let embedding: number[] | undefined;
		if (row.embedding) {
			const view = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
			embedding = Array.from(view);
		}
		return {
			id: row.id,
			uri: URI.parse(row.uri),
			name: row.name,
			type: row.type,
			role: row.role ?? undefined,
			parentId: row.parentId ?? undefined,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			range: {
				startLine: row.startLine,
				startColumn: row.startColumn,
				endLine: row.endLine,
				endColumn: row.endColumn,
			},
			text: row.text,
			embedding,
		};
	}

	private _mapRowToEdge(row: any): IndexedEdge {
		return {
			id: row.id,
			sourceId: row.sourceId,
			sourceUri: URI.parse(row.sourceUri),
			targetId: row.targetId ?? undefined,
			targetUri: row.targetUri ? URI.parse(row.targetUri) : undefined,
			targetName: row.targetName ?? undefined,
			type: row.type,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
		};
	}
}
