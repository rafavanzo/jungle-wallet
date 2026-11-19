import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação de provedores. Hoje permite tudo.
 *
 * Em produção: validar o token OIDC emitido por um IdP externo (Keycloak ou
 * Zitadel) e conferir que o providerId do token é o mesmo do payload.
 * Não se aplica aos endpoints de health.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
