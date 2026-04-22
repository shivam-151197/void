/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { join } from '../../../../../base/common/path.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IVoidIndexMainService, IndexedSymbol, FileIndexInfo } from '../../common/index/indexServiceTypes.js';
import type { Database } from '@vscode/sqlite3';

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
		if (this._db) return this._db;

		this._db = (async () => {
			const sqlite3 = (await import('@vscode/sqlite3')).verbose();
			return new Promise<Database>((resolve, reject) => {
				const db = new sqlite3.Database(this._dbPath, (err) => {
					if (err) return reject(err);
					db.serialize(() => {
						db.run('CREATE TABLE IF NOT EXISTS files (uri TEXT PRIMARY KEY, hash TEXT, lastIndexed INTEGER)');
						db.run('CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, uri TEXT, name TEXT, type TEXT, startLine INTEGER, startColumn INTEGER, endLine INTEGER, endColumn INTEGER, text TEXT, embedding BLOB)');
						db.run('CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri)');
						resolve(db);
					});
				});
			});
		})();

		return this._db;
	}

	async updateFileIndex(uri: string, hash: string, symbols: IndexedSymbol[]): Promise<void> {
		console.log(`[VoidIndexMainService] Indexing file: ${uri}, hash: ${hash}, symbols: ${symbols.length}`);
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.serialize(() => {
				db.run('BEGIN TRANSACTION');
				db.run('INSERT OR REPLACE INTO files (uri, hash, lastIndexed) VALUES (?, ?, ?)', [uri, hash, Date.now()]);
				db.run('DELETE FROM symbols WHERE uri = ?', [uri]);
				const stmt = db.prepare('INSERT INTO symbols (id, uri, name, type, startLine, startColumn, endLine, endColumn, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
				for (const symbol of symbols) {
					let embeddingBlob: Buffer | null = null;
					if (symbol.embedding) {
						embeddingBlob = Buffer.from(new Float32Array(symbol.embedding).buffer);
						console.log(`[VoidIndexMainService] Saving embedding for symbol: ${symbol.name}`);
					}
					stmt.run([
						symbol.id,
						uri,
						symbol.name,
						symbol.type,
						symbol.range.startLine,
						symbol.range.startColumn,
						symbol.range.endLine,
						symbol.range.endColumn,
						symbol.text,
						embeddingBlob
					]);
				}
				stmt.finalize();
				db.run('COMMIT', (err) => {
					if (err) {
						console.error('[VoidIndexMainService] Error committing transaction:', err);
						return reject(err);
					}
					console.log(`[VoidIndexMainService] Successfully indexed ${uri}`);
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
				resolve({ uri: (row as any).uri, hash: (row as any).hash, lastIndexed: (row as any).lastIndexed } as any);
			});
		});
	}

	async getSymbols(uri: string): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.all('SELECT * FROM symbols WHERE uri = ?', [uri], (err, rows) => {
				if (err) return reject(err);
				resolve(rows.map(row => this._mapRowToSymbol(row)));
			});
		});
	}

	async searchSymbols(query: string): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.all('SELECT * FROM symbols WHERE name LIKE ? LIMIT 50', [`%${query}%`], (err, rows) => {
				if (err) return reject(err);
				resolve(rows.map(row => this._mapRowToSymbol(row)));
			});
		});
	}

	async semanticSearch(queryEmbedding: number[], limit: number = 10): Promise<IndexedSymbol[]> {
		const db = await this._getDb();
		return new Promise((resolve, reject) => {
			db.all('SELECT * FROM symbols WHERE embedding IS NOT NULL', [], (err, rows) => {
				if (err) return reject(err);
				const symbols = rows.map(row => this._mapRowToSymbol(row));

				// Ranking by cosine similarity
				const ranked = symbols
					.map(s => ({
						symbol: s,
						score: this._cosineSimilarity(queryEmbedding, s.embedding!)
					}))
					.sort((a, b) => b.score - a.score)
					.slice(0, limit)
					.map(item => item.symbol);

				resolve(ranked);
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
		let embedding: number[] | undefined = undefined;
		if (row.embedding) {
			const view = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
			embedding = Array.from(view);
		}
		return {
			id: row.id,
			uri: row.uri,
			name: row.name,
			type: row.type,
			range: {
				startLine: row.startLine,
				startColumn: row.startColumn,
				endLine: row.endLine,
				endColumn: row.endColumn,
			},
			text: row.text,
			embedding: embedding
		} as any;
	}
}
