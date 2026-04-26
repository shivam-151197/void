/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IAiEmbeddingVectorService, IAiEmbeddingVectorProvider } from '../../../services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
// Ignored import
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export interface IVoidEmbeddingProvider {
	readonly _serviceBrand: undefined;
}
export const IVoidEmbeddingProvider = createDecorator<IVoidEmbeddingProvider>('voidEmbeddingProvider');

export class VoidEmbeddingProvider implements IVoidEmbeddingProvider, IAiEmbeddingVectorProvider, IWorkbenchContribution {

	static readonly ID = 'void.embeddingProvider';
	_serviceBrand: undefined;
	private readonly _disposable: IDisposable;

	constructor(
		@IAiEmbeddingVectorService private readonly _aiEmbeddingVectorService: IAiEmbeddingVectorService,
// Ignored _llmMessageService intentionally
	) {
		console.log('VoidEmbeddingProvider: registering embedding provider');
		this._disposable = this._aiEmbeddingVectorService.registerAiEmbeddingVectorProvider('void', this);
	}

	dispose(): void {
		this._disposable.dispose();
	}

	async provideAiEmbeddingVector(strings: string[], token: CancellationToken): Promise<number[][]> {
		// Return dummy empty arrays to halt network generation but satisfy the service interface.
		return strings.map(() => []);
	}

}

registerSingleton(IVoidEmbeddingProvider, VoidEmbeddingProvider, InstantiationType.Eager);

class VoidEmbeddingProviderWorkbenchContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voidEmbeddingProvider';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		instantiationService.createInstance(VoidEmbeddingProvider);
	}
}

registerWorkbenchContribution2(VoidEmbeddingProviderWorkbenchContribution.ID, VoidEmbeddingProviderWorkbenchContribution, WorkbenchPhase.BlockRestore);
