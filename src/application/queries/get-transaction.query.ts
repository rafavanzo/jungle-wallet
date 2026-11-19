import { TransactionNotFoundError } from '../errors/application-errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { type TransactionView, toTransactionView } from './views.js';

export class GetTransactionByIdQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(transactionId: string): Promise<TransactionView> {
    const transaction = await this.uow.run(({ transactions }) =>
      transactions.findById(transactionId),
    );
    if (!transaction) {
      throw new TransactionNotFoundError(`Transação ${transactionId} não encontrada`);
    }
    return toTransactionView(transaction);
  }
}

export class GetTransactionByExternalIdQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.uow.run(({ transactions }) =>
      transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) {
      throw new TransactionNotFoundError(
        `Transação ${externalTransactionId} do provedor ${providerId} não encontrada`,
      );
    }
    return toTransactionView(transaction);
  }
}
