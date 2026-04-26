const sqlite3 = require('./node_modules/@vscode/sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'test_void_indexing.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

console.log('--- Starting Indexing Verification ---');

const db = new sqlite3.Database(dbPath, (err) => {
	if (err) {
		console.error('Failed to create database:', err);
		process.exit(1);
	}

	db.serialize(() => {
		// Create tables
		db.run('CREATE TABLE files (uri TEXT PRIMARY KEY, hash TEXT, lastIndexed INTEGER)');
		db.run('CREATE TABLE symbols (id TEXT PRIMARY KEY, uri TEXT, name TEXT, type TEXT, startLine INTEGER, startColumn INTEGER, endLine INTEGER, endColumn INTEGER, text TEXT, embedding BLOB)');
		db.run('CREATE INDEX idx_symbols_uri ON symbols(uri)');

		console.log('Tables created successfully.');

		// Mock data
		const uri = 'file:///test/file.ts';
		const hash = 'abc123hash';
		const symbols = [
			{
				id: 'sym1',
				name: 'testFunction',
				type: 'function_declaration',
				range: { startLine: 1, startColumn: 1, endLine: 5, endColumn: 20 },
				text: 'function testFunction() { console.log("hello"); }',
				embedding: [0.1, 0.2, 0.3, 0.4, 0.5] // Sample 5-dim embedding
			}
		];

		// Simulate updateFileIndex
		db.run('BEGIN TRANSACTION');
		db.run('INSERT OR REPLACE INTO files (uri, hash, lastIndexed) VALUES (?, ?, ?)', [uri, hash, Date.now()]);

		const stmt = db.prepare('INSERT INTO symbols (id, uri, name, type, startLine, startColumn, endLine, endColumn, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
		for (const symbol of symbols) {
			let embeddingBlob = null;
			if (symbol.embedding) {
				embeddingBlob = Buffer.from(new Float32Array(symbol.embedding).buffer);
				console.log(`Simulating saving embedding for symbol: ${symbol.name}`);
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
				console.error('Transaction failed:', err);
			} else {
				console.log('Transaction committed successfully.');

				// Verify data
				console.log('\n--- Verifying Data ---');

				db.get('SELECT * FROM files WHERE uri = ?', [uri], (err, row) => {
					console.log('File index entry:', row);
					if (row && row.hash === hash) {
						console.log('SUCCESS: File index hash matches.');
					} else {
						console.error('FAILURE: File index hash mismatch or not found.');
					}
				});

				db.all('SELECT * FROM symbols WHERE uri = ?', [uri], (err, rows) => {
					console.log('Symbol entries found:', rows.length);
					if (rows.length > 0) {
						const s = rows[0];
						console.log('First symbol details:', {
							name: s.name,
							type: s.type,
							range: `${s.startLine}:${s.startColumn}-${s.endLine}:${s.endColumn}`,
							hasEmbedding: !!s.embedding
						});

						if (s.embedding) {
							const view = new Float32Array(s.embedding.buffer, s.embedding.byteOffset, s.embedding.byteLength / 4);
							const recoveredEmbedding = Array.from(view);
							console.log('Recovered Embedding (first 3):', recoveredEmbedding.slice(0, 3));

							const match = JSON.stringify(recoveredEmbedding) === JSON.stringify(symbols[0].embedding);
							if (match) {
								console.log('SUCCESS: Embedding recovered correctly.');
							} else {
								console.error('FAILURE: Embedding recovered incorrectly.');
								console.log('Expected:', symbols[0].embedding);
								console.log('Actual:', recoveredEmbedding);
							}
						}
					} else {
						console.error('FAILURE: Symbols not found.');
					}
				});
			}
		});
	});
});
