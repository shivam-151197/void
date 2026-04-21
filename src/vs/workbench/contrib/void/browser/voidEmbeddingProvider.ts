/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IAiEmbeddingVectorService, IAiEmbeddingVectorProvider } from '../../../services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
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
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
	) {
		console.log('VoidEmbeddingProvider: registering embedding provider');
		this._disposable = this._aiEmbeddingVectorService.registerAiEmbeddingVectorProvider('void', this);
	}

	dispose(): void {
		this._disposable.dispose();
	}

	async provideAiEmbeddingVector(strings: string[], token: CancellationToken): Promise<number[][]> {
		console.log(`Void: Creating embedding for ${strings.length} strings: [${strings.map(s => s.substring(0, 20)).join(', ')}...]`);
		return new Promise((resolve, reject) => {
			const disposable = token.onCancellationRequested(() => {
				disposable.dispose();
				reject(new Error('Cancelled'));
			});

			this._llmMessageService.getEmbeddings({
				text: strings,
				onSuccess: ({ embeddings }) => {
					disposable.dispose();
					resolve(embeddings);
				},
				onError: ({ error }) => {
					disposable.dispose();
					reject(new Error(error));
				}
			});
		});
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
