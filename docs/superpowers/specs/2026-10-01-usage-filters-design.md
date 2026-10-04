# Filtros de uso por provider e API key, ranking e tags — Design

> Substitui `2026-09-04-usage-provider-filter-and-tts-design.md` (WIP nunca commitado, feito sobre 0.5.55).
> Base: `upstream/master` v0.5.95. Branch `feat/usage-filters`, worktree `.worktrees/usage-filters`.

## Objetivo

Em `/dashboard/usage` (aba Overview), permitir **filtrar** todo o consumo por **provider** e por **API key do 9router**
(chaves individuais, tags de chaves, "sem chave" e "chaves desconhecidas"), **classificar** as chaves num ranking de
consumo, e **etiquetar** chaves com tags. O filtro é um setting global do servidor (o mesmo em todos os navegadores).
Toda requisição à API passa a ser registrada no histórico, separando trabalho de metadados (ver "Registro universal").

## Decisões (tomadas com o usuário em 2026-10-01)

| Tema | Decisão |
|---|---|
| "Classificar" | Ranking por consumo **e** tags nas chaves |
| Escopo do filtro | Página Overview inteira: cards, gráfico temporal, By Provider, Top Models, ranking, tabelas, Recent Requests, topologia |
| Persistência | Setting global no servidor (`settings.usageFilter`), last-write-wins |
| Base / WIP | Partir de v0.5.95; unificar com o filtro de provider + registro de TTS do WIP de setembro |
| Deploy | Última tarefa do plano, com backup e rollback |

## Dados existentes (verificado em produção 2026-10-01)

- `usageHistory` guarda `apiKey` (chave crua) em toda request; 3.092 linhas desde 2026-07-28, 100% com chave; sem retenção/prune.
- `usageDaily.data.byApiKey` agrega por `chave|modelo|provider` por dia.
- 7 chaves em `apiKeys` (2 pausadas). Nenhuma linha órfã hoje, mas chaves apagadas/não registradas são possíveis.
- Não há índice em `usageHistory.apiKey`.
- **Vazamento atual:** `/api/usage/stats` envia ao navegador objetos `byApiKey` cujas *chaves do mapa* contêm a API key crua.

## Modelo do filtro

```js
settings.usageFilter = {
  providers: { mode: "all" | "selected", ids: ["openai", "edge-tts"] },          // ids canônicos, minúsculos
  apiKeys:   { mode: "all" | "selected", ids: ["<apiKeys.id>", "__none__", "__unknown__"], tags: ["clientes"] },
  requestKind: "work" | "meta" | "all",                                           // default "work"
}
```

- `mode: "all"` → dimensão não filtra (inclui itens novos automaticamente); `ids`/`tags` normalizados para `[]`.
- `mode: "selected"` com listas vazias → não inclui nada (resultado zerado, não "tudo").
- Uma request entra se passa nas **duas** dimensões (AND). Dentro de `apiKeys`, a chave entra se o `id` está em `ids`
  **ou** se tem alguma tag em `tags` (OR) — tags são resolvidas na hora da consulta (chave que ganha/perde tag entra/sai).
- `__none__` = requests sem API key. `__unknown__` = chaves que não estão na tabela `apiKeys` (apagadas ou nunca registradas).
- Ids de chave que não existem mais são ignorados (sem erro).
- Validação: modos válidos, arrays de strings não vazias, ≤ 200 itens por lista, dedupe; inválido → HTTP 400 sem gravar.
- Setting ausente ou corrompido → tratado como `all/all`.
- O navegador nunca recebe a chave crua: só `apiKeys.id`, nome, tags e (para desconhecidas) id `ext:<sha256[0:10]>` + máscara.

## Arquitetura

- **Filtragem no servidor.** As rotas `/api/usage/stats`, `/api/usage/chart` e `/api/usage/stream` leem o filtro salvo
  e passam um filtro *resolvido* (`resolveUsageFilter(filter, catalogoDeChaves)`) ao repositório.
- **Sem filtro ativo** → caminho atual inalterado (resumo diário `usageDaily` para 7d/30d/60d/all).
- **Com filtro ativo** → agregação exata a partir de `usageHistory` para qualquer período, com
  `WHERE timestamp >= ? AND <cláusula do filtro>`; o mesmo laço de agregação já usado para `today`/`24h`.
  Janelas de calendário (`today`, `7d`, `30d`, `60d`) começam à meia-noite local, iguais ao resumo diário.
- Índice novo `usageHistory(apiKey, timestamp)`; coluna nova `apiKeys.tags` (JSON). Mudanças aditivas
  (auto-sync de schema), `SCHEMA_VERSION` 1 → 3.
- `byApiKey` é re-chaveado por `apiKeyId` antes de sair do repositório (corrige o vazamento) e ganha `apiKeyId`;
  a resposta de stats ganha `apiKeyCatalog` (`id, name, isActive, tags`) e `filterActive`.
- `GET/PUT /api/usage/filter` → `{ filter, options: { providers:[{id,label}], apiKeys:[{id,name,isActive,tags}], tags:[] } }`.
  Opções de provider = providers distintos em `usageHistory` ∪ conexões ativas (independem do filtro atual).
- **Requests em andamento** (pulsos na topologia) só são filtradas por provider: o rastreio em memória não conhece a
  API key. A UI informa isso quando há filtro de chave.

## Ranking e tags

- Card "API Key Ranking": agrupa `byApiKey` por chave (ou por tag), métrica Tokens / Cost / Requests, barra
  proporcional + % do total, ordenado desc. Clicar numa chave/tag aplica filtro "só ela". No modo por tag, chave com
  várias tags conta em cada uma (aviso na UI); chaves sem tag vão para "(untagged)" (não clicável).
- Tags: até 10 por chave, minúsculas, espaços → `-`, até 32 chars, sem `,` nem `|`. Editadas na lista de chaves
  (`/dashboard`, seção API Keys) por modal com entrada separada por vírgula. `PUT /api/keys/:id { tags }`.
  Export/import do DB preserva tags.

## Registro universal de requisições (decidido em 2026-10-01, 2ª rodada)

**Toda** requisição `/v1/*` e `/v1beta/*` (inclusive as rotas reescritas `/codex`, `/responses`, `/systemone`) gera
**exatamente uma** linha em `usageHistory`, com sucesso ou erro. Exceção: `OPTIONS` (preflight CORS do navegador)
não é registrada.

| Campo | Valor |
|---|---|
| `kind` | `"work"` (pede trabalho a um provider) ou `"meta"` (só metadados) — coluna nova, default `'work'` |
| `httpStatus` | código HTTP final — coluna nova |
| `status` | `"ok"` (< 400), `"error"` (≥ 400) ou `"aborted"` (cliente fechou o stream antes do fim) |
| `provider`/`model`/`connectionId` | o que o handler chegou a resolver; antes disso `"unknown"` (`"9router"` em meta) |
| `apiKey` | chave enviada (Bearer, `x-api-key`, `x-goog-api-key`, `?key=`), truncada em 256 chars |
| tokens | os reais quando o provider informa; senão 0 |

- **Meta:** `GET /v1`, `/v1/models*`, `/v1/audio/voices`, `/v1/messages/count_tokens`, `GET /v1beta/models`,
  `GET /v1/videos/:id` (polling de status). O resto é **work**.
- **Mecanismo:** cada rota é embrulhada por `withRequestUsage` (AsyncLocalStorage). O handler só enriquece o registro
  (`currentRequestUsage()?.set({ provider, model, connectionId, tokens })`) e o wrapper grava ao final, a partir do
  status da resposta. No chat, o sucesso continua sendo gravado pelo `chatCore` (tokens do fim do stream); o handler
  sinaliza `handOff()` e o wrapper não duplica. Agora o `chatCore` grava mesmo sem `usage` (tokens 0) e grava
  `"aborted"` quando o cliente desconecta no meio do stream, com trava para nunca gravar duas vezes.
- **Recusas no guard** (requisição remota sem chave ou com chave inválida, 401 antes de chegar à rota) também viram linha.
- Linhas **meta** ficam só em `usageHistory` (não entram no resumo diário `usageDaily` nem no contador vitalício).
- **Recent Requests** mostra todas as linhas (inclusive sem tokens) e só remove duplicatas exatas.
- **Filtro:** nova dimensão `requestKind: "work" | "meta" | "all"`, default `"work"`. A UI tem um seletor
  Work / Metadata / All. Com o default, os números do dashboard são só de trabalho real.
- **Testes:** o setup do Vitest isola `HOME` num diretório temporário, para que rotas embrulhadas nunca gravem no
  `~/.9router` real.

## Fora de escopo

Preferência por usuário; filtro nas abas Details/Logs e na página Quota; filtro por endpoint/modelo; estimar tokens de
TTS/mídia; rastrear API key nas requests em andamento; registrar `OPTIONS`; retenção/limpeza do histórico; mudar o resumo diário `usageDaily`.

## Erros

- Filtro inválido → 400, nada gravado. Falha de DB → 500 genérico.
- UI: falha no GET → aviso não bloqueante; falha no PUT → mantém a seleção visual, aviso, nova mudança tenta de novo.
  Gravação com debounce de 400 ms.

## Verificação

Vitest (unitários com SQLite temporário via `DATA_DIR`), `npm run build`, smoke com cópia do DB de produção em porta
separada, e após deploy: requests reais do live-test (chat + TTS) e de metadados aparecem no uso com `kind` certo, filtros por chave/tag/provider batem com SQL direto.
