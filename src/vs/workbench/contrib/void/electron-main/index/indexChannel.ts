/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../../base/common/event.js';
import { IVoidIndexMainService } from '../../common/index/indexServiceTypes.js';

export class IndexChannel implements IServerChannel {

	constructor(private readonly service: IVoidIndexMainService) { }

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`Event not found: ${event}`);
	}

	async call(_: unknown, command: string, params: any): Promise<any> {
		switch (command) {
			case 'updateFileIndex': return this.service.updateFileIndex(params.uri, params.hash, params.graph);
			case 'getFileIndex': return this.service.getFileIndex(params.uri);
			case 'getSymbols': return this.service.getSymbols(params.uri);
			case 'searchSymbols': return this.service.searchSymbols(params.query);
			case 'searchCallers': return this.service.searchCallers(params.query);
			case 'getContextNeighborhoods': return this.service.getContextNeighborhoods(params.query, params.options);
			case 'semanticSearch': return this.service.semanticSearch(params.queryEmbedding, params.limit);
			case 'searchDirectories': return this.service.searchDirectories(params.query, params.limit);
		}

		throw new Error(`Invalid command: ${command}`);
	}
}
