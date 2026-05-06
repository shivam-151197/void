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
			case 'updateFileIndex': return this.service.updateFileIndex(params[0], params[1], params[2]);
			case 'getFileIndex': return this.service.getFileIndex(params[0]);
			case 'getSymbols': return this.service.getSymbols(params[0]);
			case 'searchSymbols': return this.service.searchSymbols(params[0]);
			case 'searchCallers': return this.service.searchCallers(params[0]);
			case 'getContextNeighborhoods': return this.service.getContextNeighborhoods(params[0], params[1]);
			case 'semanticSearch': return this.service.semanticSearch(params[0], params[1]);
			case 'searchDirectories': return this.service.searchDirectories(params[0], params[1]);
			case 'exportGraph': return this.service.exportGraph(params[0]);
		}

		throw new Error(`Invalid command: ${command}`);
	}
}
