import { URI } from '../src/vs/base/common/uri.js';
import { runSearchCodebase } from '../src/vs/workbench/contrib/void/common/contextGathering/searchCodebaseTool.ts';

async function main() {
	const args = process.argv.slice(2);
	const query = args[0] || 'authentication';
	const searchType = args[1] || 'definition';

	console.log(`Testing search for: "${query}" (Type: ${searchType})\n`);

	const mockCandidates = [
		{
			path: 'models/user.model.js',
			uri: URI.file('/home/shivam/Desktop/Uniflow/work/master/models/user.model.js').toString(),
			searchHitCount: 5,
			contentPreview: 'const UserSchema = new mongoose.Schema({...})',
			symbols: [{ name: 'setPassword', kind: 'method' }, { name: 'validPassword', kind: 'method' }],
			evidenceSnippets: [{ startLine: 10, endLine: 15, text: 'UserSchema.methods.setPassword = function(password) { ... }' }]
		},
		{
			path: 'authValidator/validateToken.js',
			uri: URI.file('/home/shivam/Desktop/Uniflow/work/master/authValidator/validateToken.js').toString(),
			searchHitCount: 3,
			contentPreview: 'module.exports = function validateToken(req, res, next) {...}',
			symbols: [{ name: 'validateToken', kind: 'function' }],
			evidenceSnippets: [{ startLine: 1, endLine: 5, text: 'module.exports = function validateToken(req, res, next) { ... }' }]
		}
	];

	const result = await runSearchCodebase(
		{ query, searchType: searchType as any },
		{
			expandQuery: async () => 'authentication, login, token',
			getCandidates: async () => mockCandidates as any,
			rerankCandidates: async () => JSON.stringify({
				ranked: [
					{ path: 'authValidator/validateToken.js', relevance: 'high', reason: 'Primary token validation logic' },
					{ path: 'models/user.model.js', relevance: 'medium', reason: 'Defines user authentication methods' }
				],
				suggested_next: 'Check socket events for authorization handlers.'
			})
		}
	);

	console.log('--- Search Summary ---');
	console.log(result.search_summary);
	console.log('\n--- Files ---');
	result.files.forEach((f, i) => {
		console.log(`\n### Result ${i + 1}: ${f.path}`);
		console.log(`Full Path: ${f.fullPath}`);
		console.log(`Relevance: ${f.relevance}`);
		console.log(`Reason: ${f.reason}`);
		console.log(`Symbols: ${f.symbols.join(', ')}`);
		console.log(`Preview:\n\`\`\`\n${f.preview}\n\`\`\``);
	});
	console.log('\n--- Grounding Rules ---');
	console.log(result.grounding_rules);
	console.log('\n--- Suggested Next ---');
	console.log(result.suggested_next);
}

main().catch(err => {
	console.error('Test failed:', err);
	process.exit(1);
});
