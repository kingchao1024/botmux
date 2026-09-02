import { join } from 'node:path';

export const ASK_RECEIPT_AUTHORITY_DIRECTORY = 'ask-receipt-authority';
export const ASK_RECEIPT_SIGNING_KEY_FILE = 'signing-key.json';
export const ASK_CARD_EVENT_CLAIM_DIRECTORY = join('dedup', 'ask-card-events');
export const ASK_PERSIST_DIRECTORY = 'asks';

export function askReceiptSigningKeyPath(botmuxConfigDir: string): string {
  return join(botmuxConfigDir, ASK_RECEIPT_AUTHORITY_DIRECTORY, ASK_RECEIPT_SIGNING_KEY_FILE);
}

export function askCardEventClaimDirectory(dataDir: string): string {
  return join(dataDir, ASK_CARD_EVENT_CLAIM_DIRECTORY);
}

export function askPersistDirectory(dataDir: string): string {
  return join(dataDir, ASK_PERSIST_DIRECTORY);
}
