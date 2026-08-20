# ForwardPro Cloud — versão corrigida e evoluída

Sistema local de gestão de redirecionamentos, clientes, cotações e pedidos com Node.js, Express 5, PostgreSQL e autenticação JWT.

## O que foi corrigido

- Compatibilidade com Express 5: removido wildcard `app.get('*')` que causava `path-to-regexp Missing parameter name`.
- Todas as rotas autenticadas agora usam `req.user.id` de forma consistente.
- Corrigida a associação `user_id` de clientes, cotações, pedidos e histórico.
- Corrigido o login para retornar também o `role` do usuário.
- Corrigida a criação de cotações para respeitar o schema real do PostgreSQL.
- Adicionado valor numérico das cotações/pedidos para dashboards e relatórios.
- Adicionado histórico de cotações e pedidos.
- Adicionado controle de status dos pedidos.
- Adicionada página de configurações persistida no banco.
- Melhorado tratamento de erros da API e de indisponibilidade do servidor.
- Frontend atualizado para refletir os dados do PostgreSQL em vez de IndexedDB.

## Funcionalidades

- Login e cadastro
- Administrador e permissões
- Dashboard com indicadores reais
- Clientes
- Cotações
- Produtos por cotação
- Calculadora de custo, frete, impostos, margem e lucro
- Histórico de cotações
- Conversão de cotação em pedido
- Pedidos com atualização de status
- Histórico de pedidos
- Fretes favoritos/configurados no frontend
- Configuração de margem padrão
- Limpeza dos dados do usuário
- Painel administrativo
- Health check em `/api/health`

## Instalação

1. Instale PostgreSQL para Windows.
2. Crie o banco `forwardpro`.
3. Copie `.env.example` para `.env`.
4. Configure `DATABASE_URL` e `JWT_SECRET`.
5. Execute:

```powershell
npm install
```

6. Crie/atualize as tabelas. O próprio `npm start` executa o `schema.sql` e as migrações seguras automaticamente.
7. Crie o administrador:

```powershell
npm run admin:create
```

8. Inicie:

```powershell
npm start
```

9. Abra:

```text
http://localhost:3000
```

## Teste do banco

Abra:

```text
http://localhost:3000/api/health
```

Resultado esperado:

```json
{"ok":true,"database":true,"service":"ForwardPro Cloud"}
```

## Importante

O `.env` não deve ser publicado nem enviado para repositórios. Use `.env.example` como modelo.

## Catálogo próprio de fretes

O ForwardPro não depende de token, cookie, device-id ou sessão de terceiros. Na página **Fretes**, cadastre suas tabelas de envio e marque seus fretes favoritos. A calculadora calcula automaticamente o valor pelo peso usando primeiro peso + peso adicional.

## Recursos adicionais

- Edição completa de clientes.
- Adicionais/serviços extras em cada cotação.
- Observações por cotação.
- Edição de cotações já salvas.
- Histórico de alterações.
- Conversão de cotação em pedido.
- Geração de PDF com resumo, produtos, frete, taxas, adicionais, margem e preço final.
- PostgreSQL persistente e autenticação.
