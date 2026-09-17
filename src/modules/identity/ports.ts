import type { IdentityContext, JsonObject } from '../../shared/types.js';

export interface Credential {
  readonly value: string;
  readonly kind: 'bearer' | 'gateway' | 'session';
}

export interface IdentityProvider {
  resolve(credential: Credential): Promise<IdentityContext>;
}

export interface AuthorizationPort {
  authorize(request: {
    readonly identity: IdentityContext;
    readonly action: string;
    readonly resource?: JsonObject;
    readonly input: JsonObject;
    readonly environment?: JsonObject;
  }): Promise<import('../../shared/types.js').AuthorizationDecision>;
}
