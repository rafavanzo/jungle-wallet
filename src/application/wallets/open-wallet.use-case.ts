import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { Money, type MoneyProps } from '../../domain/shared/money.js';
import { WagerTransactionProcessed } from '../../domain/wagering/events/wager-transaction-processed.js';
import { WalletBalanceChanged } from '../../domain/wagering/events/wallet-balance-changed.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { InvalidPlayerIdError, WalletAlreadyExistsError } from '../errors/application-errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import { UniqueConstraint, UniqueViolationError } from '../ports/persistence-errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface OpenWalletCommand {
  playerId: string;
  /** A moeda da wallet é a do saldo inicial. */
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Com saldo inicial positivo, grava na mesma transação SQL a
 * transação interna OPENING, o lançamento CREDIT e os eventos.
 */
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const { playerId, correlationId } = command;
    if (typeof playerId !== 'string' || playerId.trim() === '') {
      throw new InvalidPlayerIdError('playerId deve ser uma string não vazia');
    }

    const now = this.clock.now();
    const eventContext = () => ({ eventId: this.ids.next(), correlationId, occurredAt: now });

    try {
      return await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        const { wallet, openingEntry } = Wallet.open({
          id: this.ids.next(),
          playerId,
          initialBalance,
          openingTransactionId: this.ids.next(),
          openingEntryId: this.ids.next(),
          at: now,
        });

        // Ordem imposta pelas FKs: wallet → transação → lançamento.
        await wallets.insert(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingEntry.transactionId,
            walletId: wallet.id,
            playerId,
            money: initialBalance,
            at: now,
          });
          await transactions.insert(opening);
          await ledger.insert(openingEntry);
          await outbox.insert(
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())),
          );
          await outbox.insert(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventContext())),
          );
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        error.constraint === UniqueConstraint.WalletPlayerCurrency
      ) {
        throw new WalletAlreadyExistsError(
          `O player ${playerId} já tem uma wallet em ${initialBalance.currency}`,
        );
      }
      throw error;
    }
  }
}
