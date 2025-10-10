declare module "applesauce-signers" {
  import type { EventSigner } from "applesauce-factory";
  export interface SimpleSignerOptions {
    secret?: string;
  }
  export class SimpleSigner implements EventSigner {
    constructor(options?: SimpleSignerOptions);
    static fromKey(secret: string): SimpleSigner;
    getPublicKey(): Promise<string>;
    signEvent(draft: import("nostr-tools").EventTemplate): Promise<import("nostr-tools").NostrEvent>;
    readonly nip04?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
    readonly nip44?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
  }
}
