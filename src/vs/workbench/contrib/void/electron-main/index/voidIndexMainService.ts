/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IndexedContextNeighborhood, IndexedEdge, IndexedFileGraph, IndexedSymbol, FileIndexInfo, IVoidIndexMainService, VoidIndexQueryIntent, RankedDirectory } from '../../common/index/indexServiceTypes.js';

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
		console.log('[VoidIndexMainService] DATABASE PATH:', this._dbPath);
		if (this._db) {
			return this._db;
		}

		this._db = (async () => {
			const mod = await import('@vscode/sqlite3');
			const sqlite3 = (mod.default || mod);
			const sqlite3_verbose = sqlite3.verbose ? sqlite3.verbose() : sqlite3;
			return new Promise<Database>((resolve, reject) => {
				const db = new sqlite3_verbose.Database(this._dbPath, (err) => {
					if (err) {
						console.error('[VoidIndexMainService] Error opening database:', err);
						return reject(err);
					}

					db.serialize(() => {
						// 1. Initial table creation - now including parentId for new databases
						db.run('CREATE TABLE IF NOT EXISTS files (uri TEXT PRIMARY KEY, hash TEXT, lastIndexed INTEGER)', (err) => {
							if (err) console.error('[VoidIndexMainService] Error creating files table:', err);
						});
						db.run('CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, uri TEXT, name TEXT, type TEXT, role TEXT, metadata TEXT, startLine INTEGER, startColumn INTEGER, endLine INTEGER, endColumn INTEGER, text TEXT, embedding BLOB, parentId TEXT)', (err) => {
							if (err) console.error('[VoidIndexMainService] Error creating symbols table:', err);
						});
						db.run('CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, sourceId TEXT, sourceUri TEXT, targetId TEXT, targetUri TEXT, targetName TEXT, type TEXT, metadata TEXT)', (err) => {
							if (err) console.error('[VoidIndexMainService] Error creating edges table:', err);
						});

						// 2. Migration: Ensure parentId exists in symbols (for existing databases)
						db.all('PRAGMA table_info(symbols)', (err, columns: any[]) => {
							if (err) {
								console.error('[VoidIndexMainService] Error checking symbols table info:', err);
								// Fallback: try to resolve anyway, though errors might follow
								resolve(db);
								return;
							}

							const hasParentId = columns.some(c => c.name === 'parentId');
							const hasRole = columns.some(c => c.name === 'role');
							const hasMetadata = columns.some(c => c.name === 'metadata');
							
							const completeInit = () => {
								// 4. Auto-repair: If we have files but no symbols, clear the files table to force a re-index
								db.get('SELECT COUNT(*) as symbolCount FROM symbols', (err, sRow: any) => {
									if (!err && sRow && sRow.symbolCount === 0) {
										db.get('SELECT COUNT(*) as fileCount FROM files', (err, fRow: any) => {
											if (!err && fRow && fRow.fileCount > 0) {
												console.log('[VoidIndexMainService] Inconsistent state detected (files but no symbols). Clearing files table for fresh index...');
												db.run('DELETE FROM files', () => {
													finalizeInit();
												});
											} else {
												finalizeInit();
											}
										});
									} else {
										finalizeInit();
									}
								});
							};

							const finalizeInit = () => {
								db.serialize(() => {
									db.run('CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri)', (err) => {
										if (err) console.error('[VoidIndexMainService] Error creating index idx_symbols_uri:', err);
									});
									db.run('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)', (err) => {
										if (err) console.error('[VoidIndexMainService] Error creating index idx_symbols_name:', err);
									});
									db.run('CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parentId)', (err) => {
										if (err) console.error('[VoidIndexMainService] Error creating index idx_symbols_parent:', err);
									});
									db.run('CREATE INDEX IF NOT EXISTS idx_edges_source_id ON edges(sourceId)', (err) => {
										if (err) console.error('[VoidIndexMainService] Error creating index idx_edges_source_id:', err);
									});
									db.run('CREATE INDEX IF NOT EXISTS idx_edges_source_uri ON edges(sourceUri)', (err) => {
										if (err) console.error('[VoidIndexMainService] Error creating index idx_edges_source_uri:', err);
									});
									db.run('CREATE INDEX IF NOT EXISTS idx_edges_target_name ON edges(targetName)', (err) => {
										if (err) console.error('[VoidIndexMainService] Error creating index idx_edges_target_name:', err);
									});
									resolve(db);
								});
							};

							if (!hasParentId || !hasRole || !hasMetadata) {
								db.serialize(() => {
									if (!hasParentId) {
										db.run('ALTER TABLE symbols ADD COLUMN parentId TEXT', (err) => {
											if (err) console.error('[VoidIndexMainService] Error adding parentId column:', err);
										});
									}
									if (!hasRole) {
										db.run('ALTER TABLE symbols ADD COLUMN role TEXT', (err) => {
											if (err) console.error('[VoidIndexMainService] Error adding role column:', err);
										});
									}
									if (!hasMetadata) {
										db.run('ALTER TABLE symbols ADD COLUMN metadata TEXT', (err) => {
											if (err) console.error('[VoidIndexMainService] Error adding metadata column:', err);
										});
									}
									completeInit();
								});
							} else {
								completeInit();
							}
						});
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
				db.run('BEGIN TRANSACTION', (err) => {
					if (err) console.error('[VoidIndexMainService] BEGIN TRANSACTION failed:', err);
				});
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
					], (err) => {
						if (err) console.error(`[VoidIndexMainService] Error inserting symbol ${symbol.name} in ${uri}:`, err);
					});
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
						console.error('[VoidIndexMainService] COMMIT failed:', err);
						db.run('ROLLBACK');
						return reject(err);
					}
					console.log(`[VoidIndexMainService] Successfully indexed file: ${uri}`);
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

	async searchDirectories(query: string, limit: number = 10): Promise<RankedDirectory[]> {
		const db = await this._getDb();
		const queryTerms = this._extractQueryTerms(query).slice(0, 6);
		if (queryTerms.length === 0) return [];

		const queryClauses = queryTerms.map(() => '(LOWER(name) LIKE ? OR LOWER(text) LIKE ?)');
		const exacts = queryTerms.map(() => '?').join(', ');
		const params: string[] = [];
		for (const term of queryTerms) {
			params.push(`%${term}%`, `%${term}%`);
		}
		params.push(...queryTerms);

		const sql = `
			SELECT 
				uri,
				COUNT(*) as totalMatches,
				SUM(CASE WHEN LOWER(name) IN (${exacts}) THEN 10 ELSE 1 END) as fileScore
			FROM symbols
			WHERE role != 'file' AND (${queryClauses.join(' OR ')})
			GROUP BY uri
			ORDER BY fileScore DESC
			LIMIT 200
		`;

		const rows = await this._all(db, sql, params, row => ({
			uri: row.uri as string,
			matches: row.totalMatches as number,
			score: row.fileScore as number
		}));

		const dirScores = new Map<string, { score: number; reasons: Set<string> }>();
		for (const row of rows) {
			const uri = URI.parse(row.uri);
			const segments = uri.path.split('/').filter(Boolean);
			segments.pop(); // Remove filename
			
            // Add entries for all parent directories to account for deeply nested relevance
			let currentPath = '';
			for (const segment of segments) {
				currentPath += (currentPath ? '/' : '') + segment;
				const stats = dirScores.get(currentPath) ?? { score: 0, reasons: new Set() };
				stats.score += row.score;
				if (row.matches > 0) {
					stats.reasons.add(`contains matching symbols`);
				}
				dirScores.set(currentPath, stats);
			}
		}

		return Array.from(dirScores.entries())
			.map(([path, stats]) => ({
				uri: URI.file(path),
				score: stats.score,
				reason: Array.from(stats.reasons).join(', ')
			}))
			.sort((a, b) => b.score - a.score)
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
	async exportGraph(workspaceUri: string): Promise<void> {
		const db = await this._getDb();
		const fs = await import('fs/promises');
		const path = await import('path');
		const baseUri = URI.parse(workspaceUri);
		
		console.log(`[VoidIndexMainService] Exporting graph for workspace: ${workspaceUri}`);
		const dbSize = await this._all(db, 'SELECT COUNT(*) as count FROM symbols', [], row => row.count);
		console.log(`[VoidIndexMainService] Total symbols in DB: ${dbSize[0]}`);
		const sampleUris = await this._all(db, 'SELECT DISTINCT uri FROM symbols LIMIT 5', [], row => row.uri);
		console.log(`[VoidIndexMainService] Sample URIs in DB: ${JSON.stringify(sampleUris)}`);

		const workspaceUriNoSlash = workspaceUri.endsWith('/') ? workspaceUri.slice(0, -1) : workspaceUri;
		const workspaceUriWithSlash = workspaceUriNoSlash + '/';

		const symbols = await this._all(db, 'SELECT * FROM symbols WHERE uri LIKE ? OR uri = ?', [`${workspaceUriWithSlash}%`, workspaceUriNoSlash], row => this._mapRowToSymbol(row));
		const edges = await this._all(db, 'SELECT * FROM edges WHERE sourceUri LIKE ? OR sourceUri = ?', [`${workspaceUriWithSlash}%`, workspaceUriNoSlash], row => this._mapRowToEdge(row));

		// Reachability Analysis
		const entryPoints = symbols.filter(s => {
			const filename = s.uri.path.split('/').pop()?.toLowerCase() || '';
			return s.type === 'file' && (filename.startsWith('index.') || filename.startsWith('main.') || filename.startsWith('app.'));
		});

		const reachableNodes = new Set<string>();
		const queue = [...entryPoints.map(s => s.id)];
		
		// Build adjacency list for fast BFS
		const adjacency = new Map<string, string[]>();
		for (const edge of edges) {
			if (edge.targetId) {
				const list = adjacency.get(edge.sourceId) || [];
				list.push(edge.targetId);
				adjacency.set(edge.sourceId, list);
			}
		}

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			if (!reachableNodes.has(currentId)) {
				reachableNodes.add(currentId);
				const neighbors = adjacency.get(currentId) || [];
				for (const next of neighbors) {
					if (!reachableNodes.has(next)) {
						queue.push(next);
					}
				}
			}
		}

		const graphDir = path.join(baseUri.fsPath, '.void', 'graph');
		await fs.mkdir(graphDir, { recursive: true });
		
		const graphData = {
			nodes: symbols.map(s => ({
				id: s.id,
				uri: s.uri.toString(),
				name: s.name,
				type: s.type,
				role: s.role,
				parentId: s.parentId,
				range: s.range,
				isReachable: reachableNodes.has(s.id)
			})),
			edges: edges.map(e => ({
				id: e.id,
				sourceId: e.sourceId,
				targetId: e.targetId,
				type: e.type
			}))
		};
		
		await fs.writeFile(path.join(graphDir, 'graph.json'), JSON.stringify(graphData, null, 2));
		console.log(`[VoidIndexMainService] Exported graph to ${graphDir}/graph.json with ${symbols.length} nodes (${reachableNodes.size} reachable) and ${edges.length} edges`);
	}
}
