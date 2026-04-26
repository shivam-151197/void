import { chat_systemMessage } from './out/vs/workbench/contrib/void/common/prompt/prompts.js';
import * as fs from 'fs';

const res = chat_systemMessage({
    workspaceFolders: [],
    directoryStr: '',
    openedURIs: [],
    activeURI: '',
    persistentTerminalIDs: [],
    semanticSnippets: [],
    chatMode: 'plan',
    mcpTools: undefined,
    includeXMLToolDefinitions: true
});

fs.writeFileSync('/home/shivam/Desktop/void/test_prompt_out.txt', res);
