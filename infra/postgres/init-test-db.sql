-- Banco separado para os testes de integração. O teste de reversibilidade roda
-- o down() da migration, que apaga todas as tabelas.
-- Executado pelo Postgres só na primeira inicialização (volume vazio).
CREATE DATABASE jungle_wallet_test;
