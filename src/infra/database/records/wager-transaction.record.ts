import { EntitySchema } from '@mikro-orm/postgresql';

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultingBalance!: string | null;
  /** Moeda da wallet; pode diferir de `currency` numa rejeição por CURRENCY_MISMATCH. */
  resultingBalanceCurrency!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    resultingBalance: { type: 'decimal', columnType: 'numeric(20,2)', nullable: true },
    resultingBalanceCurrency: { type: 'string', columnType: 'char(3)', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});
