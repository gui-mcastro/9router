# Filtros de uso (providers + API keys), ranking e tags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar toda requisição à API (trabalho e metadados, sucesso e erro), filtrar a página `/dashboard/usage` por provider, API key/tag e tipo de requisição, mostrar um ranking de consumo por chave/tag, permitir tags nas chaves, e colocar isso em produção.

**Architecture:** O filtro é um setting global (`settings.usageFilter`). As rotas de uso o leem e passam um filtro *resolvido* ao `usageRepo`. Sem filtro, o caminho atual (resumo diário) fica igual. Com filtro, tudo é agregado exatamente a partir de `usageHistory` com uma cláusula SQL. `byApiKey` é re-chaveado por id da chave para que a chave crua nunca chegue ao navegador. Toda rota `/v1*` é embrulhada por `withRequestUsage` (AsyncLocalStorage): o handler enriquece o registro com provider/modelo/conta/tokens e o wrapper grava exatamente uma linha (`kind` work/meta, `httpStatus`) ao final; no chat, o sucesso continua gravado pelo `chatCore`. A UI (Next.js client components) só lê e grava o filtro e re-busca os dados.

**Tech Stack:** Next.js 16 (App Router, webpack), React 19, Tailwind, recharts, SQLite (adapter próprio em `src/lib/db`), Vitest 4 (pacote separado em `tests/`), Node 22.

**Spec:** `docs/superpowers/specs/2026-10-01-usage-filters-design.md`

## Global Constraints

- Base: branch `feat/usage-filters` a partir de `upstream/master` **v0.5.95**, worktree `/home/ubuntu/src/9router/.worktrees/usage-filters`. Não usar o `master` do fork (0.5.55).
- Rodar testes sempre de `tests/`: `cd /home/ubuntu/src/9router/.worktrees/usage-filters/tests && npx vitest run unit/<arquivo>.test.js`.
- `export npm_config_cache=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/npm-cache` antes de `npm`/`npx`: `~/.npm` tem arquivos do root (EACCES). Não usar sudo.
- Textos da UI em **inglês** (o dashboard inteiro é em inglês). Comentários de código em inglês, curtos, no estilo do arquivo.
- A API key crua nunca pode aparecer em resposta de `/api/usage/*` (só `apiKeys.id`, nome, tags, máscara, `ext:<hash>`).
- Ids especiais exatos: `"__none__"` (sem chave) e `"__unknown__"` (chave fora da tabela `apiKeys`).
- Tags: minúsculas, espaços → `-`, 1–32 chars, sem `,` nem `|`, no máximo 10 por chave.
- Listas do filtro: no máximo 200 itens cada. Debounce de gravação na UI: 400 ms.
- Mudanças de schema só aditivas (`syncSchemaFromTables`). `SCHEMA_VERSION` 1 → 2 (Task 1) → 3 (Task 4) → 4 (Task 5).
- **Toda** requisição `/v1*` gera **exatamente uma** linha em `usageHistory` (sucesso ou erro), exceto `OPTIONS` (preflight CORS). `kind` ∈ `"work"`/`"meta"`; `status` ∈ `"ok"`/`"error"`/`"aborted"`; `httpStatus` = código final.
- Filtro: `requestKind` ∈ `"work"`/`"meta"`/`"all"`, default `"work"`. Linhas meta não entram em `usageDaily` nem no contador vitalício.
- Testes nunca podem gravar no `~/.9router` real: o setup do Vitest (Task 4) isola `HOME`.
- Não tocar em `tests/translator/thinking-unified.test.js` do checkout principal nem no worktree `.worktrees/usage-provider-filter-tts` (WIP antigo, substituído por este plano; remover só depois do merge, com o usuário).
- Commits locais por tarefa; **não fazer push** sem o usuário pedir. Mensagens terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deploy (Task 15) exige confirmação explícita do usuário antes de parar o processo de produção: o live-test 24/7 depende do 9router.

## Review Focus

1. **Filtro salvo aponta para uma chave que foi apagada.** Esperado: nada quebra e a chave some do resultado (zero), sem 500. Teste na Task 5 (`ignores ids of deleted keys`).
2. **"Selecionar tudo explicitamente" difere de "All".** Selecionar todas as chaves + `__none__` + `__unknown__` em 7d tem que dar os mesmos totais do caminho sem filtro (resumo diário). Isso pega diferença de janela entre histórico e resumo diário. Teste na Task 5 (`explicit full selection matches unfiltered totals`).
3. **Setting corrompido ou legado** (lixo em `settings.usageFilter`, ou o `usageProviderFilter` do WIP). Esperado: GET devolve `all/all` e as stats não quebram. Teste na Task 3 (`falls back to all when the stored filter is corrupt`).
4. **Caixa diferente no provider** (`"OpenAI"` gravado, `"openai"` selecionado). Esperado: casa. Teste na Task 5 (`matches providers case-insensitively`).
5. **Cliente fecha um stream no meio, ou fecha logo depois do fim.** Esperado: exatamente uma linha (`aborted` no primeiro caso, `ok` com tokens no segundo), nunca duas. Teste na Task 8 (`records one row when completion and abort race`).

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/apiKeyTags.js` (novo) | Normalizar, serializar e parsear tags de chave (puro, usável no cliente) |
| `src/lib/usageFilter.js` (novo) | Modelo do filtro: default, normalização, resolução contra o catálogo, SQL e predicado em memória (puro) |
| `src/lib/db/repos/usageApiKeyRedaction.js` (novo) | `maskApiKey`, id estável por chave (`apiKeyIdFor`), re-chavear `byApiKey` |
| `src/lib/db/repos/usageFilterRepo.js` (novo) | Ler/gravar o filtro nos settings, resolver, montar opções |
| `src/app/api/usage/filter/route.js` (novo) | `GET`/`PUT` do filtro + opções |
| `src/lib/db/schema.js` | Coluna `apiKeys.tags`, índice `idx_uh_apikey_ts`, `SCHEMA_VERSION` |
| `src/lib/db/repos/apiKeysRepo.js`, `src/lib/db/index.js`, `src/app/api/keys/[id]/route.js` | Tags nas chaves (CRUD + export/import) |
| `src/lib/db/repos/settingsRepo.js` | Default `usageFilter` |
| `src/lib/requestKind.js` (novo) | Classificar requisição em `work`/`meta` por método + caminho (puro) |
| `src/lib/requestUsage.js` (novo) | `withRequestUsage` (wrapper de rota), `currentRequestUsage`, `recordRejectedRequest`, `extractRequestApiKey` |
| `tests/setup/isolate-home.js` (novo) | Isolar `HOME` nos testes |
| `src/lib/db/repos/usageRepo.js` | `saveRequestUsage` grava `kind`/`httpStatus`; `getUsageStats`/`getChartData`/`getActiveRequests` aceitam filtro resolvido; redação; Recent Requests com todas as linhas |
| `src/app/api/usage/{stats,chart,stream}/route.js` | Aplicar o filtro salvo |
| `src/app/api/v1/**/route.js`, `src/app/api/v1beta/**/route.js` | Embrulhar com `withRequestUsage` |
| `src/sse/handlers/*.js`, `open-sse/handlers/chatCore*.js` | Enriquecer o registro; chat grava sucesso sem tokens e stream abortado |
| `src/dashboardGuard.js` | Registrar recusas 401 da API pública |
| `src/app/(dashboard)/dashboard/usage/components/usageFilterState.js` (novo) | Transições puras do filtro na UI |
| `src/app/(dashboard)/dashboard/usage/components/useUsageFilter.js` (novo) | Hook: GET, PUT com debounce, versão |
| `src/app/(dashboard)/dashboard/usage/components/UsageFilterBar.js` (novo) | Dropdowns Providers / API Keys (+ tags) |
| `src/app/(dashboard)/dashboard/usage/components/apiKeyRanking.js` (novo) | Agregação pura do ranking |
| `src/app/(dashboard)/dashboard/usage/components/ApiKeyRankingCard.js` (novo) | Card do ranking |
| `src/app/(dashboard)/dashboard/usage/page.js`, `src/shared/components/UsageStats.js`, `.../usage/components/UsageChart.js` | Integração |
| `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` | Editor de tags na lista de chaves |
| `tests/unit/*.test.js` (novos) | Um arquivo de teste por tarefa |

---

### Task 1: Tags nas API keys (lib, schema, repo, rota, export/import)

**Files:**
- Create: `src/lib/apiKeyTags.js`
- Modify: `src/lib/db/schema.js` (`SCHEMA_VERSION`, `apiKeys.columns`)
- Modify: `src/lib/db/repos/apiKeysRepo.js`
- Modify: `src/lib/db/index.js:80` (exportDb) e `:138-143` (importDb)
- Modify: `src/app/api/keys/[id]/route.js` (PUT)
- Test: `tests/unit/api-key-tags.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `normalizeApiKeyTags(value: unknown): string[]` (lança `TypeError`)
  - `parseStoredTags(text: string|null): string[]`
  - `parseTagInput(text: string): string[]` (lança `TypeError`)
  - `serializeTags(value: unknown): string` (JSON; nunca lança, inválido → `"[]"`)
  - Todo objeto de chave vindo do repo (`getApiKeys`, `getApiKeyById`, `createApiKey`, `updateApiKey`) tem `tags: string[]`.
  - `PUT /api/keys/:id` aceita `{ tags: string[] }` → 200 `{ key }` ou 400 `{ error }`.

- [ ] **Step 0: Preparar o workspace (uma vez só)**

O worktree já existe (criado no planejamento a partir de `upstream/master`). Confira e instale as dependências.

`~/.npm` tem arquivos do root, e por isso `npm install` falha com EACCES. **Não use sudo.** Use um cache próprio:

```bash
cd /home/ubuntu/src/9router/.worktrees/usage-filters
git status --short            # esperado: só docs/superpowers/{specs,plans} não rastreados
git log --oneline -1          # esperado: a99cf572 # v0.5.95 (2026-10-01)
mkdir -p /home/ubuntu/src/9router/.worktrees/.usage-filters-tmp   # arquivos temporários (fora do git, ignorados pelo repo principal via .worktrees/)
export npm_config_cache=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/npm-cache
[ -d node_modules ] || npm install --no-audit --no-fund
cd tests && { [ -d node_modules ] || npm install --no-audit --no-fund --legacy-peer-deps; }   # sem --legacy-peer-deps o npm 10.9.8 quebra com "reading 'edgesOut'"
# a linha de base já foi gerada no planejamento (2957 pass / 102 fail, ~15 min); só gere de novo se o arquivo não existir
[ -f /home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/baseline.json ] || npx vitest run --reporter=json --outputFile=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/baseline.json > /dev/null 2>&1
```

A suíte **não** fica toda verde num checkout limpo (`CLAUDE.md`: ~64 falhas esperadas). A linha de base em JSON serve para a Task 14 comparar e detectar regressões. O `tests/__baseline__/verify-no-regression.mjs` do repo assume o caminho `/app/` e não funciona aqui. O `security-audit.test.js` falha **inteiro** na base (13 testes), porque usa `path.resolve("src/...")` e quebra rodando de `tests/`. Além disso, "byApiKey object keys should use masked key" estaria errado mesmo da raiz, porque o v0.5.95 chaveia por chave crua. A Task 5 reescreve o bloco AUDIT-002 com `import.meta.url`. Os outros blocos AUDIT continuam falhando como antes e não são regressão. A suíte completa leva mais de 10 minutos.

Em todo shell novo das próximas tarefas, rode `export npm_config_cache=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/npm-cache` antes de qualquer `npm`/`npx`.

Commit dos documentos:

```bash
cd /home/ubuntu/src/9router/.worktrees/usage-filters
git add docs/superpowers/specs/2026-10-01-usage-filters-design.md docs/superpowers/plans/2026-10-01-usage-filters.md
git commit -m "docs: spec and plan for usage filters by provider and API key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/api-key-tags.test.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeApiKeyTags, parseStoredTags, parseTagInput, serializeTags,
} from "../../src/lib/apiKeyTags.js";

describe("api key tag helpers", () => {
  it("normalizes case, whitespace and duplicates", () => {
    expect(normalizeApiKeyTags([" Clientes ", "clientes", "Time A"])).toEqual(["clientes", "time-a"]);
    expect(normalizeApiKeyTags(undefined)).toEqual([]);
    expect(normalizeApiKeyTags(null)).toEqual([]);
    expect(normalizeApiKeyTags(["", "   "])).toEqual([]);
  });

  it.each([
    ["not-an-array"],
    [[1]],
    [["a,b"]],
    [["a|b"]],
    [["x".repeat(33)]],
    [Array.from({ length: 11 }, (_, i) => `t${i}`)],
  ])("rejects invalid tags %#", (value) => {
    expect(() => normalizeApiKeyTags(value)).toThrow(TypeError);
  });

  it("parses comma separated input", () => {
    expect(parseTagInput("a, B ,,c")).toEqual(["a", "b", "c"]);
    expect(parseTagInput("")).toEqual([]);
  });

  it("tolerates garbage in stored tags", () => {
    expect(parseStoredTags(null)).toEqual([]);
    expect(parseStoredTags("not json")).toEqual([]);
    expect(parseStoredTags('{"a":1}')).toEqual([]);
    expect(parseStoredTags('["a",2]')).toEqual(["a"]);
  });

  it("serializes safely", () => {
    expect(serializeTags(["B"])).toBe('["b"]');
    expect(serializeTags("garbage")).toBe("[]");
  });
});

describe("api key tags persistence", () => {
  let tempDir;
  let db;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-tags-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it("new keys start without tags and tags round-trip", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    expect(key.tags).toEqual([]);
    await db.updateApiKey(key.id, { tags: ["Clientes"] });
    expect((await db.getApiKeyById(key.id)).tags).toEqual(["clientes"]);
    expect((await db.getApiKeys())[0].tags).toEqual(["clientes"]);
  });

  it("updating isActive keeps tags", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    await db.updateApiKey(key.id, { tags: ["clientes"] });
    await db.updateApiKey(key.id, { isActive: false });
    const stored = await db.getApiKeyById(key.id);
    expect(stored.isActive).toBe(false);
    expect(stored.tags).toEqual(["clientes"]);
  });

  it("PUT /api/keys/:id validates and saves tags", async () => {
    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    const key = await db.createApiKey("Alpha", "machine-test");
    const put = (body) => PUT(
      new Request(`http://localhost/api/keys/${key.id}`, { method: "PUT", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: key.id }) },
    );

    const ok = await put({ tags: ["Time A"] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).key.tags).toEqual(["time-a"]);

    const bad = await put({ tags: "nope" });
    expect(bad.status).toBe(400);
    expect((await db.getApiKeyById(key.id)).tags).toEqual(["time-a"]);
  });

  it("export/import preserves tags", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    await db.updateApiKey(key.id, { tags: ["clientes"] });
    const dump = await db.exportDb();
    expect(dump.apiKeys[0].tags).toEqual(["clientes"]);
    await db.importDb(dump);
    expect((await db.getApiKeyById(key.id)).tags).toEqual(["clientes"]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/api-key-tags.test.js`
Expected: FAIL com "Failed to resolve import ../../src/lib/apiKeyTags.js".

- [ ] **Step 3: Implementar**

Crie `src/lib/apiKeyTags.js`:

```js
// Tags let users group gateway API keys (e.g. "clientes", "pessoal") for usage
// filtering and ranking. Client-safe: no node imports.

export const MAX_TAGS_PER_KEY = 10;
export const MAX_TAG_LENGTH = 32;

export function normalizeApiKeyTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("tags must be an array");
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new TypeError("tags must be strings");
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new TypeError(`tag too long (max ${MAX_TAG_LENGTH}): ${tag}`);
    if (/[,|]/.test(tag)) throw new TypeError("tags cannot contain ',' or '|'");
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS_PER_KEY) throw new TypeError(`too many tags (max ${MAX_TAGS_PER_KEY})`);
  return out;
}

export function parseTagInput(text) {
  return normalizeApiKeyTags(String(text || "").split(","));
}

export function parseStoredTags(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function serializeTags(value) {
  try {
    return JSON.stringify(normalizeApiKeyTags(value));
  } catch {
    return "[]";
  }
}
```

Em `src/lib/db/schema.js`:
- troque `export const SCHEMA_VERSION = 1;` por `export const SCHEMA_VERSION = 2;`
- em `apiKeys.columns`, depois de `createdAt: "TEXT NOT NULL",` adicione `tags: "TEXT DEFAULT '[]'",`

Em `src/lib/db/repos/apiKeysRepo.js`:
- adicione no topo `import { normalizeApiKeyTags, parseStoredTags } from "../../apiKeyTags.js";`
- em `rowToKey`, depois de `createdAt: row.createdAt,` adicione `tags: parseStoredTags(row.tags),`
- em `createApiKey`, no objeto `apiKey` adicione `tags: [],` e troque o INSERT por:

```js
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, tags) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, "[]"]
  );
```

- em `updateApiKey`, troque o bloco do UPDATE por:

```js
    const merged = { ...rowToKey(row), ...data };
    merged.tags = normalizeApiKeyTags(merged.tags);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, tags = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, JSON.stringify(merged.tags), id]
    );
```

Em `src/lib/db/index.js`:
- adicione no topo `import { parseStoredTags, serializeTags } from "../apiKeyTags.js";`
- no `exportDb`, troque a linha `apiKeys:` por:

```js
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt, tags: parseStoredTags(r.tags) })),
```

- no `importDb`, troque o laço de `payload.apiKeys` por:

```js
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, tags) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), serializeTags(k.tags)]
      );
    }
```

Em `src/app/api/keys/[id]/route.js`:
- adicione `import { normalizeApiKeyTags } from "@/lib/apiKeyTags";`
- no `PUT`, troque `const { isActive } = body;` por `const { isActive, tags } = body;` e troque o bloco `const updateData = {}; if (isActive ...)` por:

```js
    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (tags !== undefined) {
      try {
        updateData.tags = normalizeApiKeyTags(tags);
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/api-key-tags.test.js unit/db-sqlite-vs-lowdb.test.js unit/db-migration-chain.test.js`
Expected: PASS (os dois testes de DB existentes também, para confirmar que a coluna nova não quebra nada).

- [ ] **Step 5: Commit**

```bash
git add src/lib/apiKeyTags.js src/lib/db/schema.js src/lib/db/repos/apiKeysRepo.js src/lib/db/index.js "src/app/api/keys/[id]/route.js" tests/unit/api-key-tags.test.js
git commit -m "feat(keys): add tags to API keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Modelo do filtro e redação de chaves (módulos puros)

**Files:**
- Create: `src/lib/usageFilter.js`
- Create: `src/lib/db/repos/usageApiKeyRedaction.js`
- Test: `tests/unit/usage-filter-model.test.js`

**Interfaces:**
- Consumes: nada.
- Produces (`src/lib/usageFilter.js`):
  - `KEY_NONE = "__none__"`, `KEY_UNKNOWN = "__unknown__"`
  - `REQUEST_KINDS = ["work", "meta", "all"]`
  - `DEFAULT_USAGE_FILTER` (congelado) = `{ providers: { mode: "all", ids: [] }, apiKeys: { mode: "all", ids: [], tags: [] }, requestKind: "work" }`
  - `normalizeUsageFilter(value): UsageFilter` (lança `TypeError`)
  - `isUsageFilterActive(filter): boolean` (true se providers/apiKeys em `selected` **ou** `requestKind !== "work"`)
  - `resolveUsageFilter(filter, catalog: {id,key,tags}[]): Resolved` onde `Resolved = { active: boolean, requestKind: "work"|"meta"|"all", providers: Set<string>|null, keys: null | { raw: Set<string>, none: boolean, unknown: boolean }, knownRaw: Set<string> }`
  - `buildUsageFilterSql(resolved|null): { sql: string, params: any[] }` — expressão booleana para ir depois de `AND`. **Sempre** inclui o recorte de tipo (`kind = 'work'` por padrão, inclusive com `null`); só fica `""` com `requestKind: "all"` e nada mais selecionado.
  - `matchesUsageFilter(resolved|null, entry: { provider, apiKey, kind }): boolean` (entrada sem `kind` conta como `"work"`)
- Produces (`src/lib/db/repos/usageApiKeyRedaction.js`):
  - `maskApiKey(key): string|null` (mesma regra do v0.5.95: ≤12 chars → `c***`; senão 8 primeiros + `***` + 4 últimos)
  - `apiKeyIdFor(rawKey, idByRawKey: Map): string` → id do catálogo | `"__none__"` | `"ext:<sha256 10 hex>"`
  - `redactByApiKey(byApiKey: object, catalog: {id,key,name}[]): object` → mapa re-chaveado `"<apiKeyId>|<model>|<provider>"`; cada registro ganha `apiKeyId`, `keyName`, `apiKeyMasked`, `apiKeyKey = apiKeyId` e perde qualquer campo `apiKey`

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/usage-filter-model.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  KEY_NONE, KEY_UNKNOWN, DEFAULT_USAGE_FILTER,
  normalizeUsageFilter, isUsageFilterActive, resolveUsageFilter,
  buildUsageFilterSql, matchesUsageFilter,
} from "../../src/lib/usageFilter.js";
import { apiKeyIdFor, maskApiKey, redactByApiKey } from "../../src/lib/db/repos/usageApiKeyRedaction.js";

const catalog = [
  { id: "id-a", key: "sk-aaaaaaaa-1111", name: "Alpha", tags: ["clientes"] },
  { id: "id-b", key: "sk-bbbbbbbb-2222", name: "Beta", tags: [] },
];

describe("normalizeUsageFilter", () => {
  it("defaults to all/all", () => {
    expect(normalizeUsageFilter(DEFAULT_USAGE_FILTER)).toEqual({
      providers: { mode: "all", ids: [] },
      apiKeys: { mode: "all", ids: [], tags: [] },
      requestKind: "work",
    });
    expect(normalizeUsageFilter({})).toEqual(normalizeUsageFilter(DEFAULT_USAGE_FILTER));
  });

  it("lowercases provider ids and tags, keeps key ids, dedupes", () => {
    expect(normalizeUsageFilter({
      providers: { mode: "selected", ids: [" OpenAI ", "openai", "edge-tts"] },
      apiKeys: { mode: "selected", ids: ["Id-A", "Id-A", KEY_NONE], tags: ["Clientes", "clientes"] },
    })).toEqual({
      providers: { mode: "selected", ids: ["openai", "edge-tts"] },
      apiKeys: { mode: "selected", ids: ["Id-A", KEY_NONE], tags: ["clientes"] },
      requestKind: "work",
    });
  });

  it("accepts request kinds and treats non-work kinds as active", () => {
    expect(normalizeUsageFilter({ requestKind: "meta" }).requestKind).toBe("meta");
    expect(isUsageFilterActive({ ...DEFAULT_USAGE_FILTER, requestKind: "meta" })).toBe(true);
    expect(isUsageFilterActive({ ...DEFAULT_USAGE_FILTER, requestKind: "all" })).toBe(true);
  });

  it("drops lists in all mode and keeps explicit empty selections", () => {
    const f = normalizeUsageFilter({
      providers: { mode: "all", ids: ["openai"] },
      apiKeys: { mode: "selected", ids: [], tags: [] },
    });
    expect(f.providers).toEqual({ mode: "all", ids: [] });
    expect(f.apiKeys).toEqual({ mode: "selected", ids: [], tags: [] });
    expect(isUsageFilterActive(f)).toBe(true);
    expect(isUsageFilterActive(DEFAULT_USAGE_FILTER)).toBe(false);
  });

  it.each([
    [null],
    [[]],
    [{ providers: { mode: "nope", ids: [] } }],
    [{ apiKeys: { mode: "selected", ids: "id-a" } }],
    [{ apiKeys: { mode: "selected", ids: [""] } }],
    [{ apiKeys: { mode: "selected", ids: [42] } }],
    [{ providers: { mode: "selected", ids: Array.from({ length: 201 }, (_, i) => `p${i}`) } }],
    [{ requestKind: "everything" }],
  ])("rejects invalid input %#", (value) => {
    expect(() => normalizeUsageFilter(value)).toThrow(TypeError);
  });
});

describe("resolveUsageFilter + matchers", () => {
  const resolve = (f) => resolveUsageFilter(f, catalog);

  it("default filter is inactive but keeps only work requests", () => {
    const r = resolve(DEFAULT_USAGE_FILTER);
    expect(r.active).toBe(false);
    expect(buildUsageFilterSql(r)).toEqual({ sql: "kind = 'work'", params: [] });
    expect(buildUsageFilterSql(null)).toEqual({ sql: "kind = 'work'", params: [] });
    expect(matchesUsageFilter(r, { provider: "x", apiKey: null })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "x", apiKey: null, kind: "meta" })).toBe(false);
    expect(matchesUsageFilter(null, { provider: "x", kind: "meta" })).toBe(false);
  });

  it("selects metadata or every kind", () => {
    const meta = resolve({ requestKind: "meta" });
    expect(meta.active).toBe(true);
    expect(buildUsageFilterSql(meta).sql).toBe("kind = 'meta'");
    expect(matchesUsageFilter(meta, { provider: "9router", kind: "meta" })).toBe(true);
    expect(matchesUsageFilter(meta, { provider: "openai", kind: "work" })).toBe(false);
    const all = resolve({ requestKind: "all" });
    expect(buildUsageFilterSql(all)).toEqual({ sql: "", params: [] });
    expect(matchesUsageFilter(all, { provider: "9router", kind: "meta" })).toBe(true);
  });

  it("resolves key ids and tags to raw keys (OR) and ignores deleted ids", () => {
    const r = resolve({ apiKeys: { mode: "selected", ids: ["id-b", "id-gone"], tags: ["clientes"] } });
    expect([...r.keys.raw].sort()).toEqual(["sk-aaaaaaaa-1111", "sk-bbbbbbbb-2222"]);
    expect(r.keys.none).toBe(false);
    expect(r.keys.unknown).toBe(false);
  });

  it("matches none/unknown specials", () => {
    const r = resolve({ apiKeys: { mode: "selected", ids: [KEY_NONE, KEY_UNKNOWN] } });
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: null })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "" })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-ghost" })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-aaaaaaaa-1111" })).toBe(false);
  });

  it("ANDs providers with keys, provider match is case-insensitive", () => {
    const r = resolve({
      providers: { mode: "selected", ids: ["openai"] },
      apiKeys: { mode: "selected", ids: ["id-a"] },
    });
    expect(matchesUsageFilter(r, { provider: "OpenAI", apiKey: "sk-aaaaaaaa-1111" })).toBe(true);
    expect(matchesUsageFilter(r, { provider: "anthropic", apiKey: "sk-aaaaaaaa-1111" })).toBe(false);
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-bbbbbbbb-2222" })).toBe(false);
  });

  it("builds parameterized SQL in clause order", () => {
    const r = resolve({
      providers: { mode: "selected", ids: ["openai"] },
      apiKeys: { mode: "selected", ids: ["id-a", KEY_NONE, KEY_UNKNOWN] },
    });
    const { sql, params } = buildUsageFilterSql(r);
    expect(sql).toBe(
      "kind = 'work' AND LOWER(COALESCE(provider, '')) IN (?) AND (apiKey IN (?) OR (apiKey IS NULL OR apiKey = '') OR (apiKey IS NOT NULL AND apiKey <> '' AND apiKey NOT IN (SELECT key FROM apiKeys)))"
    );
    expect(params).toEqual(["openai", "sk-aaaaaaaa-1111"]);
  });

  it("empty selections match nothing", () => {
    const r = resolve({ apiKeys: { mode: "selected", ids: [], tags: [] } });
    expect(buildUsageFilterSql(r).sql).toBe("kind = 'work' AND 0");
    expect(matchesUsageFilter(r, { provider: "openai", apiKey: "sk-aaaaaaaa-1111" })).toBe(false);
  });
});

describe("api key redaction", () => {
  it("masks keys like v0.5.95", () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey("short")).toBe("s***");
    expect(maskApiKey("sk-aaaaaaaa-1111")).toBe("sk-aaaaa***1111");
  });

  it("gives stable ids", () => {
    const idByRaw = new Map([["sk-aaaaaaaa-1111", "id-a"]]);
    expect(apiKeyIdFor("sk-aaaaaaaa-1111", idByRaw)).toBe("id-a");
    expect(apiKeyIdFor(null, idByRaw)).toBe(KEY_NONE);
    expect(apiKeyIdFor("sk-ghost", idByRaw)).toMatch(/^ext:[0-9a-f]{10}$/);
    expect(apiKeyIdFor("sk-ghost", idByRaw)).toBe(apiKeyIdFor("sk-ghost", idByRaw));
  });

  it("re-keys byApiKey without raw keys and merges collisions", () => {
    const out = redactByApiKey({
      "sk-aaaaaaaa-1111|gpt|openai": { requests: 2, promptTokens: 10, completionTokens: 5, cachedTokens: 0, cost: 1, rawModel: "gpt", apiKey: "sk-aaaaaaaa-1111", lastUsed: "2026-09-01" },
      "local-no-key|gpt|openai": { requests: 1, promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0, lastUsed: "2026-09-02" },
      "local-no-key": { requests: 1, promptTokens: 2, completionTokens: 2, cachedTokens: 0, cost: 0, lastUsed: "2026-09-03T10:00:00.000Z" },
      "sk-ghost-0000000000|gpt|openai": { requests: 1, promptTokens: 3, completionTokens: 3, cachedTokens: 0, cost: 0 },
    }, catalog);

    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-aaaaaaaa-1111");
    expect(json).not.toContain("sk-ghost-0000000000");
    expect(out["id-a|gpt|openai"]).toMatchObject({ apiKeyId: "id-a", keyName: "Alpha", promptTokens: 10, apiKeyMasked: "sk-aaaaa***1111" });
    expect(out["id-a|gpt|openai"].apiKey).toBeUndefined();
    expect(out["__none__|gpt|openai"]).toMatchObject({ apiKeyId: KEY_NONE, keyName: "Local (No API Key)" });
    expect(out["__none__"]).toMatchObject({ apiKeyId: KEY_NONE, promptTokens: 2 });
    const ghost = Object.values(out).find((r) => r.apiKeyId.startsWith("ext:"));
    expect(ghost.keyName).toBe("Unknown key (sk-ghost***0000)");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/usage-filter-model.test.js`
Expected: FAIL com "Failed to resolve import ../../src/lib/usageFilter.js".

- [ ] **Step 3: Implementar**

Crie `src/lib/usageFilter.js`:

```js
// Usage dashboard filter: which providers and which gateway API keys the
// /dashboard/usage page aggregates. Persisted globally in settings.usageFilter.
// Client-safe (no node imports); resolve/SQL helpers are only called server-side.

export const KEY_NONE = "__none__"; // requests made without an API key
export const KEY_UNKNOWN = "__unknown__"; // keys missing from the apiKeys table (deleted / never registered)
// "work" asks a provider to do something; "meta" only reads router metadata (model lists, voices…).
export const REQUEST_KINDS = Object.freeze(["work", "meta", "all"]);
const MAX_IDS = 200;

export const DEFAULT_USAGE_FILTER = Object.freeze({
  providers: Object.freeze({ mode: "all", ids: Object.freeze([]) }),
  apiKeys: Object.freeze({ mode: "all", ids: Object.freeze([]), tags: Object.freeze([]) }),
  requestKind: "work",
});

function normalizeMode(mode, field) {
  if (mode !== "all" && mode !== "selected") throw new TypeError(`Invalid ${field}.mode`);
  return mode;
}

function normalizeIdList(value, field, lowercase) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > MAX_IDS) throw new TypeError(`Too many ${field}`);
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) throw new TypeError(`${field} must contain non-empty strings`);
    const id = lowercase ? raw.trim().toLowerCase() : raw.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeUsageFilter(value) {
  if (!isPlainObject(value)) throw new TypeError("Invalid usage filter");
  const providers = value.providers ?? DEFAULT_USAGE_FILTER.providers;
  const apiKeys = value.apiKeys ?? DEFAULT_USAGE_FILTER.apiKeys;
  if (!isPlainObject(providers) || !isPlainObject(apiKeys)) throw new TypeError("Invalid usage filter");

  const providerMode = normalizeMode(providers.mode, "providers");
  const keyMode = normalizeMode(apiKeys.mode, "apiKeys");
  const providerIds = normalizeIdList(providers.ids, "providers.ids", true);
  const keyIds = normalizeIdList(apiKeys.ids, "apiKeys.ids", false);
  const tags = normalizeIdList(apiKeys.tags, "apiKeys.tags", true);
  const requestKind = value.requestKind ?? "work";
  if (!REQUEST_KINDS.includes(requestKind)) throw new TypeError("Invalid requestKind");

  return {
    providers: providerMode === "all" ? { mode: "all", ids: [] } : { mode: "selected", ids: providerIds },
    apiKeys: keyMode === "all" ? { mode: "all", ids: [], tags: [] } : { mode: "selected", ids: keyIds, tags },
    requestKind,
  };
}

export function isUsageFilterActive(filter) {
  return filter?.providers?.mode === "selected"
    || filter?.apiKeys?.mode === "selected"
    || (filter?.requestKind ?? "work") !== "work";
}

// catalog: [{ id, key, tags }] from apiKeysRepo. Tags are resolved here, at query
// time, so a key that gains/loses a tag enters/leaves the filter immediately.
export function resolveUsageFilter(filter, catalog = []) {
  const f = normalizeUsageFilter(filter ?? DEFAULT_USAGE_FILTER);
  const knownRaw = new Set(catalog.map((k) => k.key).filter(Boolean));
  const resolved = { active: isUsageFilterActive(f), requestKind: f.requestKind, providers: null, keys: null, knownRaw };
  if (f.providers.mode === "selected") resolved.providers = new Set(f.providers.ids);
  if (f.apiKeys.mode === "selected") {
    const ids = new Set(f.apiKeys.ids);
    const tags = new Set(f.apiKeys.tags);
    const raw = new Set();
    for (const k of catalog) {
      if (!k.key) continue;
      if (ids.has(k.id) || (k.tags || []).some((t) => tags.has(t))) raw.add(k.key);
    }
    resolved.keys = { raw, none: ids.has(KEY_NONE), unknown: ids.has(KEY_UNKNOWN) };
  }
  return resolved;
}

// Boolean SQL expression over usageHistory columns, meant to follow "AND".
// The request-kind cut always applies: without a filter, dashboards show work only.
export function buildUsageFilterSql(resolved) {
  const clauses = [];
  const params = [];
  const kind = resolved?.requestKind ?? "work";
  if (kind !== "all") clauses.push(kind === "meta" ? "kind = 'meta'" : "kind = 'work'");
  if (!resolved?.active) return { sql: clauses.join(" AND "), params };
  if (resolved.providers) {
    if (!resolved.providers.size) {
      clauses.push("0");
    } else {
      clauses.push(`LOWER(COALESCE(provider, '')) IN (${[...resolved.providers].map(() => "?").join(", ")})`);
      params.push(...resolved.providers);
    }
  }
  if (resolved.keys) {
    const parts = [];
    if (resolved.keys.raw.size) {
      parts.push(`apiKey IN (${[...resolved.keys.raw].map(() => "?").join(", ")})`);
      params.push(...resolved.keys.raw);
    }
    if (resolved.keys.none) parts.push("(apiKey IS NULL OR apiKey = '')");
    if (resolved.keys.unknown) parts.push("(apiKey IS NOT NULL AND apiKey <> '' AND apiKey NOT IN (SELECT key FROM apiKeys))");
    clauses.push(parts.length ? `(${parts.join(" OR ")})` : "0");
  }
  return { sql: clauses.join(" AND "), params };
}

// Same semantics as buildUsageFilterSql, for in-memory entries ({ provider, apiKey, kind }).
export function matchesUsageFilter(resolved, entry) {
  const kind = resolved?.requestKind ?? "work";
  if (kind !== "all" && (entry?.kind || "work") !== kind) return false;
  if (!resolved?.active) return true;
  if (resolved.providers && !resolved.providers.has(String(entry?.provider || "").toLowerCase())) return false;
  if (resolved.keys) {
    const key = entry?.apiKey;
    if (!key) return resolved.keys.none;
    if (resolved.keys.raw.has(key)) return true;
    return resolved.keys.unknown && !resolved.knownRaw.has(key);
  }
  return true;
}
```

Crie `src/lib/db/repos/usageApiKeyRedaction.js`:

```js
import { createHash } from "node:crypto";
import { KEY_NONE } from "../../usageFilter.js";

const NO_KEY_BUCKET = "local-no-key";
const SUM_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 12) return key.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return key.slice(0, 8) + "***" + key.slice(-4);
}

// Stable, non-reversible id for a raw gateway key: catalog id when registered,
// "__none__" when absent, "ext:<hash>" for keys missing from the catalog.
export function apiKeyIdFor(rawKey, idByRawKey) {
  if (!rawKey || typeof rawKey !== "string") return KEY_NONE;
  const id = idByRawKey.get(rawKey);
  if (id) return id;
  return `ext:${createHash("sha256").update(rawKey).digest("hex").slice(0, 10)}`;
}

// stats.byApiKey is keyed by `${rawKey}|model|provider` (or "local-no-key…").
// Re-key it by API key id so raw keys never reach the browser.
export function redactByApiKey(byApiKey = {}, catalog = []) {
  const idByRaw = new Map(catalog.filter((k) => k.key).map((k) => [k.key, k.id]));
  const nameById = new Map(catalog.map((k) => [k.id, k.name]));
  const out = {};
  for (const [mapKey, rec] of Object.entries(byApiKey)) {
    const [first, ...rest] = mapKey.split("|");
    const rawKey = first === NO_KEY_BUCKET ? null : first;
    const apiKeyId = apiKeyIdFor(rawKey, idByRaw);
    const newKey = [apiKeyId, ...rest].join("|");
    const keyName = apiKeyId === KEY_NONE
      ? "Local (No API Key)"
      : nameById.get(apiKeyId) || `Unknown key (${maskApiKey(rawKey)})`;
    const { apiKey: _raw, ...clean } = rec;
    const prev = out[newKey];
    if (!prev) {
      out[newKey] = { ...clean, apiKeyId, keyName, apiKeyMasked: maskApiKey(rawKey), apiKeyKey: apiKeyId };
      continue;
    }
    for (const f of SUM_FIELDS) prev[f] = (prev[f] || 0) + (clean[f] || 0);
    if (clean.lastUsed && (!prev.lastUsed || clean.lastUsed > prev.lastUsed)) prev.lastUsed = clean.lastUsed;
  }
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/usage-filter-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usageFilter.js src/lib/db/repos/usageApiKeyRedaction.js tests/unit/usage-filter-model.test.js
git commit -m "feat(usage): add usage filter model and API key redaction helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Filtro persistido (settings + repo + `/api/usage/filter`)

**Files:**
- Modify: `src/lib/db/repos/settingsRepo.js` (`DEFAULT_SETTINGS`)
- Create: `src/lib/db/repos/usageFilterRepo.js`
- Create: `src/app/api/usage/filter/route.js`
- Test: `tests/unit/usage-filter-api.test.js`

**Interfaces:**
- Consumes: `normalizeUsageFilter`, `resolveUsageFilter`, `DEFAULT_USAGE_FILTER` (Task 2); `getApiKeys` com `tags` (Task 1).
- Produces:
  - `getUsageFilter(): Promise<UsageFilter>` (nunca lança por setting corrompido; cai para default)
  - `setUsageFilter(value): Promise<UsageFilter>` (lança `TypeError` se inválido)
  - `getResolvedUsageFilter(): Promise<Resolved>`
  - `getUsageFilterOptions(): Promise<{ providers: {id,label}[], apiKeys: {id,name,isActive,tags}[], tags: string[] }>`
  - `GET /api/usage/filter` → `{ filter, options }`; `PUT /api/usage/filter` body `UsageFilter` → `{ filter }` | 400.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/usage-filter-api.test.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let db;
let repo;
let route;

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-filter-"));
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  route = await import("@/app/api/usage/filter/route.js");
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

const put = (body) => route.PUT(new Request("http://localhost/api/usage/filter", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

describe("usage filter persistence", () => {
  it("defaults to all/all on a fresh install", async () => {
    expect(await repo.getUsageFilter()).toEqual({
      providers: { mode: "all", ids: [] },
      apiKeys: { mode: "all", ids: [], tags: [] },
      requestKind: "work",
    });
    expect((await repo.getResolvedUsageFilter()).active).toBe(false);
  });

  it("falls back to all when the stored filter is corrupt", async () => {
    await db.updateSettings({ usageFilter: { providers: "garbage" }, usageProviderFilter: { mode: "selected", providerIds: ["x"] } });
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).filter.providers.mode).toBe("all");
  });

  it("PUT normalizes, stores and returns the filter", async () => {
    const res = await put({ providers: { mode: "selected", ids: [" OpenAI "] }, apiKeys: { mode: "all" } });
    expect(res.status).toBe(200);
    expect((await res.json()).filter.providers).toEqual({ mode: "selected", ids: ["openai"] });
    expect((await repo.getUsageFilter()).providers.ids).toEqual(["openai"]);
  });

  it("PUT rejects invalid input without writing", async () => {
    expect((await put({ providers: { mode: "selected", ids: [42] } })).status).toBe(400);
    expect((await put("{not json")).status).toBe(400);
    expect((await repo.getUsageFilter()).providers.mode).toBe("all");
  });

  it("GET returns options without raw keys", async () => {
    const key = await db.createApiKey("Alpha", "machine-test");
    await db.updateApiKey(key.id, { tags: ["clientes"] });
    await db.saveRequestUsage({ provider: "OpenAI", model: "gpt", apiKey: key.key, tokens: { prompt_tokens: 1, completion_tokens: 1 }, status: "ok" });

    const res = await route.GET();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(key.key);
    expect(body.options.apiKeys).toEqual([{ id: key.id, name: "Alpha", isActive: true, tags: ["clientes"] }]);
    expect(body.options.tags).toEqual(["clientes"]);
    expect(body.options.providers.map((p) => p.id)).toContain("openai");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/usage-filter-api.test.js`
Expected: FAIL com "Failed to load url @/lib/db/repos/usageFilterRepo.js" (ou similar).

- [ ] **Step 3: Implementar**

Em `src/lib/db/repos/settingsRepo.js`:
- adicione no topo `import { DEFAULT_USAGE_FILTER } from "../../usageFilter.js";`
- dentro de `DEFAULT_SETTINGS`, como última propriedade, adicione `usageFilter: DEFAULT_USAGE_FILTER,`

Crie `src/lib/db/repos/usageFilterRepo.js`:

```js
import { getAdapter } from "../driver.js";
import { getSettings, updateSettings } from "./settingsRepo.js";
import { getApiKeys } from "./apiKeysRepo.js";
import { DEFAULT_USAGE_FILTER, normalizeUsageFilter, resolveUsageFilter } from "../../usageFilter.js";

export async function getUsageFilter() {
  const settings = await getSettings();
  try {
    return normalizeUsageFilter(settings.usageFilter ?? DEFAULT_USAGE_FILTER);
  } catch {
    // Corrupt or legacy value: behave as "show everything" rather than failing the dashboard.
    return normalizeUsageFilter(DEFAULT_USAGE_FILTER);
  }
}

export async function setUsageFilter(value) {
  const filter = normalizeUsageFilter(value);
  await updateSettings({ usageFilter: filter });
  return filter;
}

export async function getResolvedUsageFilter() {
  const [filter, catalog] = await Promise.all([getUsageFilter(), getApiKeys()]);
  return resolveUsageFilter(filter, catalog);
}

// Options do not depend on the active filter, so de-selected items stay listed.
export async function getUsageFilterOptions() {
  const db = await getAdapter();
  const ids = new Set();
  for (const r of db.all(`SELECT DISTINCT LOWER(provider) AS p FROM usageHistory WHERE provider IS NOT NULL AND provider <> ''`)) {
    ids.add(r.p);
  }

  const [{ getProviderConnections }, { getProviderNodes }, { AI_PROVIDERS }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./nodesRepo.js"),
    import("@/shared/constants/providers"),
  ]);
  try {
    for (const c of await getProviderConnections()) {
      if (c.isActive !== false && c.provider) ids.add(String(c.provider).toLowerCase());
    }
  } catch {}
  const nodeNames = {};
  try {
    for (const n of await getProviderNodes()) {
      if (n.id && n.name) nodeNames[String(n.id).toLowerCase()] = n.name;
    }
  } catch {}

  const providers = [...ids].sort().map((id) => ({ id, label: nodeNames[id] || AI_PROVIDERS[id]?.name || id }));
  const apiKeys = (await getApiKeys()).map(({ id, name, isActive, tags }) => ({ id, name, isActive, tags: tags || [] }));
  const tags = [...new Set(apiKeys.flatMap((k) => k.tags))].sort();
  return { providers, apiKeys, tags };
}
```

Crie `src/app/api/usage/filter/route.js`:

```js
import { NextResponse } from "next/server";
import { getUsageFilter, setUsageFilter, getUsageFilterOptions } from "@/lib/db/repos/usageFilterRepo.js";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const [filter, options] = await Promise.all([getUsageFilter(), getUsageFilterOptions()]);
    return NextResponse.json({ filter, options }, { headers: HEADERS });
  } catch (error) {
    console.error("[API] Failed to get usage filter:", error);
    return NextResponse.json({ error: "Failed to fetch usage filter" }, { status: 500 });
  }
}

export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const filter = await setUsageFilter(body);
    return NextResponse.json({ filter }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof TypeError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("[API] Failed to update usage filter:", error);
    return NextResponse.json({ error: "Failed to update usage filter" }, { status: 500 });
  }
}
```

`/api/usage/*` já está em `PROTECTED_API_PATHS` (`src/dashboardGuard.js`), então a rota nova exige login sem mudança extra.

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/usage-filter-api.test.js unit/usage-filter-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/repos/settingsRepo.js src/lib/db/repos/usageFilterRepo.js src/app/api/usage/filter/route.js tests/unit/usage-filter-api.test.js
git commit -m "feat(usage): persist a global usage filter with GET/PUT /api/usage/filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Registro universal — base (schema, classificação, wrapper de rota, `saveRequestUsage`, isolamento dos testes)

**Files:**
- Create: `src/lib/requestKind.js`
- Create: `src/lib/requestUsage.js`
- Create: `tests/setup/isolate-home.js`
- Modify: `tests/vitest.config.js` (`setupFiles`)
- Modify: `src/lib/db/schema.js` (`SCHEMA_VERSION` 2 → 3; `usageHistory.kind`, `usageHistory.httpStatus`, índice `idx_uh_kind_ts`)
- Modify: `src/lib/db/repos/usageRepo.js` (`saveRequestUsage`, `ensureRingInitialized`)
- Test: `tests/unit/request-usage-recording.test.js`

**Interfaces:**
- Consumes: `saveRequestUsage` (já existe, re-exportado por `@/lib/usageDb.js`).
- Produces:
  - `classifyRequestKind(method: string, pathname: string): "work" | "meta"` (`src/lib/requestKind.js`)
  - `withRequestUsage(handler) → handler` — embrulha um handler de rota Next (`(request, ctx) => Response`); grava **uma** linha ao final
  - `currentRequestUsage(): Record | null` — dentro de uma requisição embrulhada; `Record.set({ provider?, model?, connectionId?, tokens? })` (ignora `null`/`undefined`), `Record.handOff()` (sucesso será gravado depois pelo `chatCore`)
  - `recordRejectedRequest(request, httpStatus: number): void` — para recusas antes da rota (guard)
  - `extractRequestApiKey(request): string | null` — Bearer, `x-api-key`, `x-goog-api-key`, `?key=`; truncado em 256
  - `saveRequestUsage(entry)` aceita `entry.kind` (`"work"` default | `"meta"`) e `entry.httpStatus` (inteiro). Linhas meta não entram em `usageDaily` nem em `totalRequestsLifetime`.
  - Linha gravada pelo wrapper: `provider` (resolvido, senão `"unknown"`; meta: `"9router"`), `model` (senão `"unknown"`), `connectionId`, `apiKey`, `endpoint` (= pathname), `tokens` (do handler, senão 0/0), `status` (`"ok"` se < 400, senão `"error"`), `httpStatus`, `kind`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/request-usage-recording.test.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyRequestKind } from "../../src/lib/requestKind.js";

describe("test isolation", () => {
  it("tests never see the real home directory", () => {
    expect(os.homedir()).toContain("9router-test-home-");
  });
});

describe("classifyRequestKind", () => {
  it.each([
    ["GET", "/v1", "meta"],
    ["GET", "/v1/models", "meta"],
    ["GET", "/api/v1/models/openai/gpt-4o", "meta"],
    ["GET", "/v1/models/info", "meta"],
    ["GET", "/v1/audio/voices", "meta"],
    ["POST", "/v1/messages/count_tokens", "meta"],
    ["GET", "/v1beta/models", "meta"],
    ["GET", "/api/v1/videos/abc123", "meta"],
    ["POST", "/v1/chat/completions", "work"],
    ["POST", "/api/v1/responses", "work"],
    ["POST", "/codex/responses", "work"],
    ["POST", "/v1beta/models/gemini-2.5-flash:generateContent", "work"],
    ["POST", "/v1/videos/generations", "work"],
    ["POST", "/v1/audio/speech", "work"],
    ["POST", "/v1/messages", "work"],
  ])("%s %s → %s", (method, pathname, kind) => {
    expect(classifyRequestKind(method, pathname)).toBe(kind);
  });
});

describe("withRequestUsage", () => {
  let requestUsage;
  let adapter;

  beforeEach(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-request-usage-"));
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    requestUsage = await import("@/lib/requestUsage.js");
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  const rows = () => adapter.all(
    `SELECT provider, model, connectionId, apiKey, endpoint, status, httpStatus, kind, promptTokens FROM usageHistory ORDER BY id`
  );
  const req = (method, url, headers = {}) => new Request(`http://localhost${url}`, { method, headers });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("records one ok work row with what the handler resolved", async () => {
    const handler = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().set({ provider: "openai", model: "gpt-x", connectionId: "c1" });
      return new Response("ok");
    });
    const res = await handler(req("POST", "/v1/audio/speech", { authorization: "Bearer sk-client" }));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({
      provider: "openai", model: "gpt-x", connectionId: "c1", apiKey: "sk-client",
      endpoint: "/v1/audio/speech", status: "ok", httpStatus: 200, kind: "work", promptTokens: 0,
    });
  });

  it("records errors with the final status code", async () => {
    const handler = requestUsage.withRequestUsage(async () => Response.json({ error: "x" }, { status: 404 }));
    await handler(req("POST", "/v1/images/generations"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ provider: "unknown", model: "unknown", status: "error", httpStatus: 404, apiKey: null });
  });

  it("records thrown errors as 500 and rethrows", async () => {
    const handler = requestUsage.withRequestUsage(async () => { throw new Error("boom"); });
    await expect(handler(req("POST", "/v1/search"))).rejects.toThrow("boom");
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ status: "error", httpStatus: 500 });
  });

  it("skips successful requests handed off to downstream recording", async () => {
    const ok = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().handOff();
      return new Response("stream");
    });
    const failed = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().handOff();
      return new Response("x", { status: 503 });
    });
    await ok(req("POST", "/v1/chat/completions"));
    await failed(req("POST", "/v1/chat/completions"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: "error", httpStatus: 503 });
  });

  it("stores exact tokens set by the handler", async () => {
    const handler = requestUsage.withRequestUsage(async () => {
      requestUsage.currentRequestUsage().set({ provider: "openai", model: "emb", tokens: { prompt_tokens: 12, completion_tokens: 0 } });
      return new Response("ok");
    });
    await handler(req("POST", "/v1/embeddings"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].promptTokens).toBe(12);
  });

  it("records metadata requests outside the daily rollup", async () => {
    const handler = requestUsage.withRequestUsage(async () => Response.json({ data: [] }));
    await handler(req("GET", "/v1/models", { "x-api-key": "sk-meta" }));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ kind: "meta", provider: "9router", status: "ok", apiKey: "sk-meta" });
    expect(adapter.all(`SELECT dateKey FROM usageDaily`)).toEqual([]);
  });

  it("records requests rejected before routing", async () => {
    requestUsage.recordRejectedRequest(req("POST", "/v1/chat/completions?key=sk-bad"), 401);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toMatchObject({ status: "error", httpStatus: 401, apiKey: "sk-bad", kind: "work", endpoint: "/v1/chat/completions" });
  });

  it("returns null outside a wrapped request", () => {
    expect(requestUsage.currentRequestUsage()).toBeNull();
  });
});

describe("extractRequestApiKey", () => {
  it.each([
    [{ authorization: "Bearer sk-a" }, "", "sk-a"],
    [{ "x-api-key": "sk-b" }, "", "sk-b"],
    [{ "x-goog-api-key": "sk-c" }, "", "sk-c"],
    [{}, "?key=sk-d", "sk-d"],
    [{}, "", null],
  ])("%j %s", async (headers, query, expected) => {
    const { extractRequestApiKey } = await import("../../src/lib/requestUsage.js");
    expect(extractRequestApiKey(new Request(`http://localhost/v1/chat/completions${query}`, { headers }))).toBe(expected);
  });

  it("truncates absurdly long keys", async () => {
    const { extractRequestApiKey } = await import("../../src/lib/requestUsage.js");
    const request = new Request("http://localhost/v1", { headers: { authorization: `Bearer ${"x".repeat(1000)}` } });
    expect(extractRequestApiKey(request)).toHaveLength(256);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/request-usage-recording.test.js`
Expected: FAIL. O teste de isolamento falha (`homedir` é `/home/ubuntu`) e os imports de `requestKind.js`/`requestUsage.js` não resolvem.

- [ ] **Step 3: Isolar o HOME dos testes**

As rotas embrulhadas passam a gravar uso. Sem isolamento, qualquer teste que chame uma rota sem `DATA_DIR` gravaria no banco **real** de produção (`~/.9router/db/data.sqlite`), porque o caminho padrão é `os.homedir()/.9router`.

Crie `tests/setup/isolate-home.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Wrapped /v1 routes record usage. Point HOME at a throwaway dir so no test can
// ever write to the real ~/.9router database (DATA_DIR defaults to ~/.9router).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-home-"));
```

Em `tests/vitest.config.js`, dentro de `test: { ... }`, adicione `setupFiles: ["./setup/isolate-home.js"],` logo depois de `globals: true,`.

- [ ] **Step 4: Classificação e wrapper**

Crie `src/lib/requestKind.js`:

```js
// "meta" requests only read router metadata (model lists, voices, token counts,
// async job status). Everything else asks a provider to do work.
const META_PATHS = [
  /^\/v1\/?$/,
  /^\/v1\/models(\/|$)/,
  /^\/v1\/audio\/voices\/?$/,
  /^\/v1\/messages\/count_tokens\/?$/,
  /^\/v1beta\/models\/?$/,
];
const META_GET_PATHS = [/^\/v1\/videos\/[^/]+\/?$/];

export function classifyRequestKind(method, pathname) {
  const path = String(pathname || "").replace(/^\/api(?=\/v1)/, "");
  if (META_PATHS.some((re) => re.test(path))) return "meta";
  if (String(method || "").toUpperCase() === "GET" && META_GET_PATHS.some((re) => re.test(path))) return "meta";
  return "work";
}
```

Crie `src/lib/requestUsage.js`:

```js
import { AsyncLocalStorage } from "node:async_hooks";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { classifyRequestKind } from "./requestKind.js";

const MAX_KEY_LENGTH = 256;
const RECORDED_FIELDS = ["provider", "model", "connectionId", "tokens"];
// One store per process even if Next bundles this module into several chunks.
const storage = (globalThis.__requestUsageStorage ||= new AsyncLocalStorage());

function queryKey(url) {
  try {
    return new URL(url).searchParams.get("key");
  } catch {
    return null;
  }
}

// Same sources the dashboard guard accepts; truncated because rejected requests store whatever was sent.
export function extractRequestApiKey(request) {
  const headers = request.headers;
  const auth = headers.get("authorization");
  const key = auth?.startsWith("Bearer ")
    ? auth.slice(7)
    : headers.get("x-api-key") || headers.get("x-goog-api-key") || queryKey(request.url);
  return key ? key.slice(0, MAX_KEY_LENGTH) : null;
}

function createRecord(request) {
  const url = new URL(request.url);
  const fields = {};
  let handedOff = false;
  return {
    kind: classifyRequestKind(request.method, url.pathname),
    endpoint: url.pathname,
    apiKey: extractRequestApiKey(request),
    fields,
    set(values = {}) {
      for (const name of RECORDED_FIELDS) {
        if (values[name] != null) fields[name] = values[name];
      }
    },
    // Success will be written downstream (chatCore saves the row with tokens when the response completes).
    handOff() {
      handedOff = true;
    },
    get handedOff() {
      return handedOff;
    },
  };
}

function recordOutcome(record, httpStatus) {
  const ok = httpStatus < 400;
  if (ok && record.handedOff) return;
  const f = record.fields;
  Promise.resolve()
    .then(() => saveRequestUsage({
      provider: f.provider || (record.kind === "meta" ? "9router" : "unknown"),
      model: f.model || "unknown",
      connectionId: f.connectionId || null,
      apiKey: record.apiKey,
      endpoint: record.endpoint,
      tokens: f.tokens || { prompt_tokens: 0, completion_tokens: 0 },
      status: ok ? "ok" : "error",
      httpStatus,
      kind: record.kind,
    }))
    .catch(() => {});
}

export function currentRequestUsage() {
  return storage.getStore() || null;
}

// Wrap a /v1 route handler so every request leaves exactly one usageHistory row.
export function withRequestUsage(handler) {
  return async function usageRecordedHandler(request, ...rest) {
    const record = createRecord(request);
    return storage.run(record, async () => {
      let response;
      try {
        response = await handler(request, ...rest);
      } catch (error) {
        recordOutcome(record, 500);
        throw error;
      }
      recordOutcome(record, response?.status ?? 200);
      return response;
    });
  };
}

// Requests refused before any route runs (dashboard guard 401).
export function recordRejectedRequest(request, httpStatus) {
  recordOutcome(createRecord(request), httpStatus);
}
```

- [ ] **Step 5: Schema e `saveRequestUsage`**

Em `src/lib/db/schema.js`:
- `export const SCHEMA_VERSION = 3;`
- em `usageHistory.columns`, depois de `meta: "TEXT",` adicione:

```js
      kind: "TEXT DEFAULT 'work'",
      httpStatus: "INTEGER",
```

- em `usageHistory.indexes`, adicione `"CREATE INDEX IF NOT EXISTS idx_uh_kind_ts ON usageHistory(kind, timestamp)",`

`ALTER TABLE ... ADD COLUMN kind TEXT DEFAULT 'work'` faz as linhas antigas lerem `'work'`. Por isso o filtro pode usar `kind = 'work'` sem `COALESCE`.

Em `src/lib/db/repos/usageRepo.js`, dentro de `saveRequestUsage`, troque o `db.run(\`INSERT INTO usageHistory(...)\`, [...])` por:

```js
      const kind = entry.kind === "meta" ? "meta" : "work";
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, kind, httpStatus) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({}),
          kind, Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
        ]
      );

      // Metadata requests stay out of the daily rollup and lifetime counter, which back the work-only dashboard.
      if (kind === "meta") {
        inserted = true;
        return;
      }
```

O resto da transação (resumo diário, contador, `inserted = true`) fica igual, logo abaixo.

Em `ensureRingInitialized`, inclua `kind, httpStatus` no SELECT e `kind: r.kind, httpStatus: r.httpStatus,` no objeto do `.map`.

- [ ] **Step 6: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/request-usage-recording.test.js unit/usage-api-key-attribution.test.js unit/db-sqlite-vs-lowdb.test.js unit/db-migration-chain.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/requestKind.js src/lib/requestUsage.js src/lib/db/schema.js src/lib/db/repos/usageRepo.js tests/setup/isolate-home.js tests/vitest.config.js tests/unit/request-usage-recording.test.js
git commit -m "feat(usage): record every API request with kind and HTTP status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `getUsageStats` filtrado (inclui tipo de requisição), índice, redação de `byApiKey` e Recent Requests completo

**Files:**
- Modify: `src/lib/db/schema.js` (`SCHEMA_VERSION` 3 → 4, índice em `usageHistory`)
- Modify: `src/lib/db/repos/usageRepo.js` (`maskApiKey` → import; `getUsageStats`)
- Modify: `tests/unit/security-audit.test.js` (AUDIT-002: trocar varredura de código por arquivo novo)
- Test: `tests/unit/usage-filter-stats.test.js`

**Interfaces:**
- Consumes: `buildUsageFilterSql` (Task 2), `maskApiKey`, `redactByApiKey` (Task 2), `setUsageFilter`, `getResolvedUsageFilter` (Task 3); colunas `kind`/`httpStatus` e `saveRequestUsage({ kind, httpStatus })` (Task 4).
- Produces: `getUsageStats(period = "all", resolvedFilter = null)`. Retorno igual ao de hoje, mais:
  - `byApiKey` re-chaveado (`"<apiKeyId>|model|provider"`), cada registro com `apiKeyId` e `keyName`
  - `apiKeyCatalog: { id, name, isActive, tags }[]`
  - `filterActive: boolean`
  - Com `resolvedFilter.active`: totais, `byProvider`, `byModel`, `byAccount`, `byApiKey`, `byEndpoint`, `recentRequests` e `last10Minutes` só com as linhas que casam.
  - Sem filtro (ou `requestKind: "work"`): linhas `meta` nunca entram (nem no caminho de histórico de `today`/`24h`).
  - `recentRequests[i]` ganha `endpoint`, `httpStatus`, `kind`; linhas sem tokens (erros, mídia) **aparecem**; só duplicatas exatas são removidas.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/usage-filter-stats.test.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KEY_NONE, KEY_UNKNOWN } from "../../src/lib/usageFilter.js";

const GHOST = "sk-ghost-key-0000000000";
let db;
let repo;
let a;
let b;

async function save(apiKey, provider, prompt, completion, extra = {}) {
  await db.saveRequestUsage({
    provider, model: `${provider.toLowerCase()}-model`, connectionId: "c1", apiKey,
    endpoint: "/v1/chat/completions", tokens: { prompt_tokens: prompt, completion_tokens: completion },
    status: "ok", ...extra,
  });
}

async function statsWith(filter, period = "today") {
  await repo.setUsageFilter(filter);
  return db.getUsageStats(period, await repo.getResolvedUsageFilter());
}

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-stats-"));
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  a = await db.createApiKey("Alpha", "machine-test");
  b = await db.createApiKey("Beta", "machine-test");
  await db.updateApiKey(a.id, { tags: ["clientes"] });
  await save(a.key, "openai", 10, 5);
  await save(b.key, "anthropic", 20, 10);
  await save(null, "openai", 1, 1);
  await save(GHOST, "OpenAI", 3, 3);
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe("getUsageStats with a usage filter", () => {
  it("filters by key id across totals and breakdowns", async () => {
    const s = await statsWith({ apiKeys: { mode: "selected", ids: [a.id] } });
    expect(s.filterActive).toBe(true);
    expect(s.totalPromptTokens).toBe(10);
    expect(s.totalCompletionTokens).toBe(5);
    expect(s.totalRequests).toBe(1);
    expect(Object.keys(s.byProvider)).toEqual(["openai"]);
    expect(Object.values(s.byApiKey).every((r) => r.apiKeyId === a.id)).toBe(true);
    expect(s.recentRequests).toHaveLength(1);
    expect(s.recentRequests[0].promptTokens).toBe(10);
    expect(s.last10Minutes.reduce((n, m) => n + m.requests, 0)).toBe(1);
  });

  it("filters by tag", async () => {
    expect((await statsWith({ apiKeys: { mode: "selected", tags: ["clientes"] } })).totalPromptTokens).toBe(10);
  });

  it("tag filters are resolved at query time", async () => {
    await repo.setUsageFilter({ apiKeys: { mode: "selected", tags: ["clientes"] } });
    await db.updateApiKey(a.id, { tags: [] });
    const s = await db.getUsageStats("today", await repo.getResolvedUsageFilter());
    expect(s.totalPromptTokens).toBe(0);
  });

  it("matches providers case-insensitively", async () => {
    expect((await statsWith({ providers: { mode: "selected", ids: ["openai"] } })).totalPromptTokens).toBe(14);
  });

  it("ANDs providers and keys", async () => {
    const s = await statsWith({ providers: { mode: "selected", ids: ["anthropic"] }, apiKeys: { mode: "selected", ids: [a.id] } });
    expect(s.totalRequests).toBe(0);
  });

  it("selects requests without key and unknown keys", async () => {
    expect((await statsWith({ apiKeys: { mode: "selected", ids: [KEY_NONE] } })).totalPromptTokens).toBe(1);
    expect((await statsWith({ apiKeys: { mode: "selected", ids: [KEY_UNKNOWN] } })).totalPromptTokens).toBe(3);
  });

  it("empty selection shows nothing", async () => {
    const s = await statsWith({ apiKeys: { mode: "selected", ids: [], tags: [] } });
    expect(s.totalRequests).toBe(0);
    expect(s.totalPromptTokens).toBe(0);
    expect(s.recentRequests).toEqual([]);
  });

  it("ignores ids of deleted keys", async () => {
    const s = await statsWith({ apiKeys: { mode: "selected", ids: ["deleted-key-id"] } });
    expect(s.totalRequests).toBe(0);
  });

  it("explicit full selection matches unfiltered totals", async () => {
    const unfiltered = await db.getUsageStats("7d");
    const all = await statsWith({ apiKeys: { mode: "selected", ids: [a.id, b.id, KEY_NONE, KEY_UNKNOWN] } }, "7d");
    expect(all.totalPromptTokens).toBe(unfiltered.totalPromptTokens);
    expect(all.totalCompletionTokens).toBe(unfiltered.totalCompletionTokens);
    expect(all.totalRequests).toBe(unfiltered.totalRequests);
    expect(unfiltered.totalPromptTokens).toBe(34);
  });

  it("uses calendar-day windows for filtered periods", async () => {
    await save(a.key, "openai", 100, 0, { timestamp: new Date(Date.now() - 3 * 86400000).toISOString() });
    const filter = { apiKeys: { mode: "selected", ids: [a.id] } };
    expect((await statsWith(filter, "today")).totalPromptTokens).toBe(10);
    expect((await statsWith(filter, "7d")).totalPromptTokens).toBe(110);
    expect((await statsWith(filter, "all")).totalPromptTokens).toBe(110);
  });
});

describe("getUsageStats request kinds and recent requests", () => {
  const meta = () => db.saveRequestUsage({ provider: "9router", model: "unknown", apiKey: a.key, endpoint: "/v1/models", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "meta" });

  it.each(["today", "7d"])("excludes metadata requests by default (%s)", async (period) => {
    await meta();
    const s = await db.getUsageStats(period);
    expect(s.totalRequests).toBe(4);
    expect(s.recentRequests.some((r) => r.endpoint === "/v1/models")).toBe(false);
  });

  it("shows only metadata or every kind on request", async () => {
    await meta();
    const onlyMeta = await statsWith({ requestKind: "meta" });
    expect(onlyMeta.totalRequests).toBe(1);
    expect(Object.keys(onlyMeta.byProvider)).toEqual(["9router"]);
    expect((await statsWith({ requestKind: "all" })).totalRequests).toBe(5);
  });

  it("lists zero-token rows such as errors in recent requests", async () => {
    await db.saveRequestUsage({ provider: "openai", model: "broken-model", apiKey: a.key, endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "error", httpStatus: 503, kind: "work" });
    const s = await db.getUsageStats("today");
    const row = s.recentRequests.find((r) => r.model === "broken-model");
    expect(row).toMatchObject({ status: "error", httpStatus: 503, endpoint: "/v1/chat/completions", kind: "work" });
  });
});

describe("getUsageStats API key redaction", () => {
  it.each(["today", "24h", "7d", "all"])("never returns raw keys (%s)", async (period) => {
    const s = await db.getUsageStats(period);
    const json = JSON.stringify(s);
    for (const raw of [a.key, b.key, GHOST]) expect(json).not.toContain(raw);
    expect(s.filterActive).toBe(false);
    const ids = new Set(Object.values(s.byApiKey).map((r) => r.apiKeyId));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(KEY_NONE)).toBe(true);
    expect([...ids].some((id) => id.startsWith("ext:"))).toBe(true);
    expect(s.apiKeyCatalog).toHaveLength(2);
    expect(s.apiKeyCatalog).toEqual(expect.arrayContaining([
      { id: a.id, name: "Alpha", isActive: true, tags: ["clientes"] },
      { id: b.id, name: "Beta", isActive: true, tags: [] },
    ]));
  });
});
```

Em `tests/unit/security-audit.test.js`, bloco `AUDIT-002` (testes que leem o texto do código): substitua o primeiro teste (`"source should contain maskApiKey function"`) por:

```js
  it("maskApiKey lives in the redaction module used by usageRepo", () => {
    const source = fs.readFileSync(
      new URL("../../src/lib/db/repos/usageApiKeyRedaction.js", import.meta.url),
      "utf-8"
    );
    expect(source).toContain("export function maskApiKey");
    const repoSource = fs.readFileSync(new URL("../../src/lib/db/repos/usageRepo.js", import.meta.url), "utf-8");
    expect(repoSource).toContain("redactByApiKey(stats.byApiKey");
  });
```

Remova os testes `"getUsageStats should use apiKeyMasked in byApiKey entries"` e `"byApiKey object keys should use masked key, not raw key"`. A garantia agora é comportamental (`never returns raw keys` acima). No teste do `getUsageHistory`, troque `path.resolve("src/lib/db/repos/usageRepo.js")` por `new URL("../../src/lib/db/repos/usageRepo.js", import.meta.url)` para funcionar rodando de `tests/`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/usage-filter-stats.test.js`
Expected: FAIL. `filterActive` é `undefined` e os totais filtrados vêm sem filtro (ex.: `expected 34 to be 10`).

- [ ] **Step 3: Implementar**

Em `src/lib/db/schema.js`:
- `export const SCHEMA_VERSION = 4;`
- em `usageHistory.indexes`, adicione `"CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp)",`

Em `src/lib/db/repos/usageRepo.js`:

1. Apague a função local `maskApiKey` (linhas 6-11) e adicione aos imports:

```js
import { buildUsageFilterSql } from "../../usageFilter.js";
import { maskApiKey, redactByApiKey } from "./usageApiKeyRedaction.js";
```

2. Logo antes de `export async function getUsageStats`, adicione:

```js
// Start of the history window for a period. Calendar-day periods start at local
// midnight so filtered (history) and unfiltered (usageDaily) results cover the same days.
function historyCutoffIso(period) {
  if (period === "24h") return new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
  if (period === "all") return new Date(0).toISOString();
  const days = { today: 1, "7d": 7, "30d": 30, "60d": 60 }[period] ?? 1;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.toISOString();
}
```

3. Troque a assinatura e acrescente a cláusula do filtro logo no início:

```js
export async function getUsageStats(period = "all", resolvedFilter = null) {
  const db = await getAdapter();
  const filterSql = buildUsageFilterSql(resolvedFilter);
  const fWhere = filterSql.sql ? ` AND ${filterSql.sql}` : "";
  const fParams = filterSql.params;
```

4. `recentRows` e o `.map`/`.filter` que vêm logo depois:

```js
  const recentRows = db.all(`SELECT timestamp, provider, model, tokens, status, endpoint, httpStatus, kind FROM usageHistory WHERE 1 = 1${fWhere} ORDER BY id DESC LIMIT 100`, fParams);
```

No objeto do `.map`, adicione `endpoint: r.endpoint, httpStatus: r.httpStatus ?? null, kind: r.kind || "work",`. Troque o `.filter((e) => { ... })` inteiro (o que descarta linhas com 0 tokens e deduplica por minuto) por:

```js
    // Every row is a real request now (errors and media carry zero tokens); only drop exact duplicates.
    .filter((e) => {
      const key = `${e.timestamp}|${e.model}|${e.provider}|${e.endpoint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
```

5. `recent10`:

```js
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?${fWhere}`,
    [tenMinutesAgo.toISOString(), now.toISOString(), ...fParams]
  );
```

6. `const useDailySummary = period !== "24h" && period !== "today";` vira:

```js
  // Daily rollups cannot be filtered by key/provider combos: any active filter aggregates history rows.
  const useDailySummary = !resolvedFilter?.active && period !== "24h" && period !== "today";
```

7. No `else` (comentário `// 24h / today: live history`), troque o cálculo de `cutoff` e o SELECT por:

```js
    // 24h / today, or any period with an active filter: exact aggregation from history
    const cutoff = historyCutoffIso(period);
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?${fWhere}`,
      [cutoff, ...fParams]
    );
```

8. Antes de `return stats;` no fim de `getUsageStats`:

```js
  stats.byApiKey = redactByApiKey(stats.byApiKey, allApiKeys);
  stats.apiKeyCatalog = allApiKeys.map(({ id, name, isActive, tags }) => ({ id, name, isActive, tags: tags || [] }));
  stats.filterActive = !!resolvedFilter?.active;
```

`getUsageHistory` continua usando `maskApiKey` (agora importado).

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/usage-filter-stats.test.js unit/usage-api-key-attribution.test.js unit/cached-token-e2e.test.js unit/security-audit.test.js unit/db-sqlite-vs-lowdb.test.js`
Expected: PASS em todos, exceto os blocos AUDIT-001/003/004/018 do `security-audit.test.js`, que já falhavam na base por causa do caminho. O AUDIT-002 tem que passar. `usage-api-key-attribution` continua com 2 entradas, porque as duas chaves desconhecidas recebem hashes `ext:` diferentes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.js src/lib/db/repos/usageRepo.js tests/unit/usage-filter-stats.test.js tests/unit/security-audit.test.js
git commit -m "feat(usage): filter usage stats by provider/API key and stop leaking raw keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `getChartData` filtrado

**Files:**
- Modify: `src/lib/db/repos/usageRepo.js` (`getChartData`)
- Test: `tests/unit/usage-filter-chart.test.js`

**Interfaces:**
- Consumes: `buildUsageFilterSql` (Task 2); coluna `kind` (Task 4); `getLocalDateKey` (já existe em `usageRepo.js`).
- Produces: `getChartData(period = "7d", resolvedFilter = null)`. Os buckets continuam `{ label, tokens, cost, requests }`. Com filtro ativo e período diário, os buckets são calculados a partir de `usageHistory`. Com filtro ativo em `"all"` e sem linhas, retorna `[]`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/usage-filter-chart.test.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let db;
let repo;
let a;
let b;
const sum = (buckets, field) => buckets.reduce((n, x) => n + (x[field] || 0), 0);

async function chartWith(filter, period) {
  await repo.setUsageFilter(filter);
  return db.getChartData(period, await repo.getResolvedUsageFilter());
}

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-chart-"));
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  a = await db.createApiKey("Alpha", "machine-test");
  b = await db.createApiKey("Beta", "machine-test");
  const save = (apiKey, p, c) => db.saveRequestUsage({ provider: "openai", model: "gpt", apiKey, tokens: { prompt_tokens: p, completion_tokens: c }, status: "ok" });
  await save(a.key, 10, 5);
  await save(b.key, 20, 10);
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe("getChartData with a usage filter", () => {
  const onlyA = () => ({ apiKeys: { mode: "selected", ids: [a.id] } });

  it.each(["today", "24h", "7d", "30d", "all"])("only counts the selected key (%s)", async (period) => {
    const buckets = await chartWith(onlyA(), period);
    expect(sum(buckets, "tokens")).toBe(15);
    expect(sum(buckets, "requests")).toBe(1);
  });

  it("keeps the bucket layout of the unfiltered chart", async () => {
    expect(await chartWith(onlyA(), "7d")).toHaveLength(7);
    expect(await chartWith(onlyA(), "today")).toHaveLength(24);
  });

  it("empty selection returns zero buckets, and [] for all", async () => {
    const none = { apiKeys: { mode: "selected", ids: [] } };
    const week = await chartWith(none, "7d");
    expect(week).toHaveLength(7);
    expect(sum(week, "tokens")).toBe(0);
    expect(await chartWith(none, "all")).toEqual([]);
  });

  it("unfiltered chart is unchanged", async () => {
    expect(sum(await db.getChartData("7d"), "tokens")).toBe(45);
  });

  it("ignores metadata requests unless asked", async () => {
    await db.saveRequestUsage({ provider: "9router", model: "unknown", endpoint: "/v1/models", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "meta" });
    expect(sum(await db.getChartData("today"), "requests")).toBe(2);
    expect(sum(await db.getChartData("7d"), "requests")).toBe(2);
    expect(sum(await chartWith({ requestKind: "meta" }, "today"), "requests")).toBe(1);
    expect(sum(await chartWith({ requestKind: "all" }, "7d"), "requests")).toBe(3);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/usage-filter-chart.test.js`
Expected: FAIL. `expected 45 to be 15`, porque o filtro ainda é ignorado.

- [ ] **Step 3: Implementar**

Em `getChartData` (`src/lib/db/repos/usageRepo.js`):

1. Assinatura e cláusula:

```js
export async function getChartData(period = "7d", resolvedFilter = null) {
  const db = await getAdapter();
  const now = Date.now();
  const filterSql = buildUsageFilterSql(resolvedFilter);
  const fWhere = filterSql.sql ? ` AND ${filterSql.sql}` : "";
```

2. Os blocos `today` e `24h` têm o mesmo SELECT. Troque **as duas** ocorrências (Edit com `replace_all: true`) de:

```js
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
```

por:

```js
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?${fWhere}`,
      [new Date(startTime).toISOString(), ...filterSql.params]
```

Como o recorte de tipo (`kind = 'work'`) sempre existe, `fWhere` nunca fica vazio: os blocos `today`/`24h` passam a ignorar linhas meta sozinhos. O caminho diário usa `usageDaily`, que nunca recebe linhas meta (Task 4).

3. Logo depois da linha `const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });` e **antes** de `if (period === "all") {`, insira:

```js
  // Filtered daily periods: usageDaily cannot be sliced by key/provider/kind, so bucket history rows by local day.
  if (resolvedFilter?.active) {
    const days = { "7d": 7, "30d": 30, "60d": 60 }[period] ?? null;
    const first = new Date();
    first.setHours(0, 0, 0, 0);
    if (days) first.setDate(first.getDate() - (days - 1));
    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?${fWhere} ORDER BY timestamp ASC`,
      [days ? first.toISOString() : new Date(0).toISOString(), ...filterSql.params]
    );
    if (!days) {
      if (!rows.length) return [];
      first.setTime(new Date(rows[0].timestamp).getTime());
      first.setHours(0, 0, 0, 0);
    }
    const byDay = {};
    for (const r of rows) {
      const b = (byDay[getLocalDateKey(r.timestamp)] ||= { tokens: 0, cost: 0, requests: 0 });
      b.tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      b.cost += r.cost || 0;
      b.requests += 1;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const count = Math.max(1, Math.round((today - first) / 86400000) + 1);
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(first);
      d.setDate(d.getDate() + i);
      const b = byDay[getLocalDateKey(d.toISOString())];
      return { label: labelFn(d), tokens: b?.tokens || 0, cost: b?.cost || 0, requests: b?.requests || 0 };
    });
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/usage-filter-chart.test.js unit/db-sqlite-vs-lowdb.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/repos/usageRepo.js tests/unit/usage-filter-chart.test.js
git commit -m "feat(usage): filter the usage chart by provider/API key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Rotas e SSE aplicam o filtro salvo

**Files:**
- Modify: `src/app/api/usage/stats/route.js`, `src/app/api/usage/chart/route.js`, `src/app/api/usage/stream/route.js`
- Modify: `src/lib/db/repos/usageRepo.js` (`getActiveRequests`)
- Test: `tests/unit/usage-filter-routes.test.js`

**Interfaces:**
- Consumes: `getResolvedUsageFilter` (Task 3), `getUsageStats(period, resolved)` (Task 5), `getChartData(period, resolved)` (Task 6), `matchesUsageFilter` (Task 2), `kind` nas entradas do ring (Task 4).
- Produces: `getActiveRequests(resolvedFilter = null)`. `recentRequests` é filtrado por tipo, provider e chave (sem filtro: só `work`), inclui linhas sem tokens e ganha `endpoint`/`httpStatus`/`kind`. `activeRequests` é filtrado só por provider, porque requests em andamento não carregam a chave.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/usage-filter-routes.test.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let db;
let repo;
let a;
let b;

beforeEach(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-routes-"));
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/usageFilterRepo.js");
  a = await db.createApiKey("Alpha", "machine-test");
  b = await db.createApiKey("Beta", "machine-test");
  await db.saveRequestUsage({ provider: "openai", model: "route-model-a", apiKey: a.key, tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok" });
  await db.saveRequestUsage({ provider: "openai", model: "route-model-b", apiKey: b.key, tokens: { prompt_tokens: 20, completion_tokens: 10 }, status: "ok" });
  await repo.setUsageFilter({ apiKeys: { mode: "selected", ids: [a.id] } });
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe("usage routes apply the saved filter", () => {
  it("GET /api/usage/stats", async () => {
    const { GET } = await import("@/app/api/usage/stats/route.js");
    const body = await (await GET(new Request("http://localhost/api/usage/stats?period=today"))).json();
    expect(body.filterActive).toBe(true);
    expect(body.totalPromptTokens).toBe(10);
  });

  it("GET /api/usage/chart", async () => {
    const { GET } = await import("@/app/api/usage/chart/route.js");
    const buckets = await (await GET(new Request("http://localhost/api/usage/chart?period=7d"))).json();
    expect(buckets.reduce((n, x) => n + x.tokens, 0)).toBe(15);
  });

  it("getActiveRequests filters recent requests from the in-memory ring", async () => {
    const resolved = await repo.getResolvedUsageFilter();
    const { recentRequests } = await db.getActiveRequests(resolved);
    const models = recentRequests.map((r) => r.model);
    expect(models).toContain("route-model-a");
    expect(models).not.toContain("route-model-b");
  });

  it("ring hides metadata by default and shows zero-token work rows", async () => {
    await db.saveRequestUsage({ provider: "9router", model: "ring-meta", endpoint: "/v1/models", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "meta" });
    await db.saveRequestUsage({ provider: "edge-tts", model: "ring-voice", endpoint: "/v1/audio/speech", tokens: { prompt_tokens: 0, completion_tokens: 0 }, status: "ok", httpStatus: 200, kind: "work" });
    const models = (await db.getActiveRequests()).recentRequests.map((r) => r.model);
    expect(models).toContain("ring-voice");
    expect(models).not.toContain("ring-meta");
  });
});
```

`getActiveRequests` já é re-exportado por `@/lib/db/index.js` (junto de `getUsageStats`).

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/usage-filter-routes.test.js`
Expected: FAIL (`filterActive` undefined / tokens 45 / modelo b presente).

- [ ] **Step 3: Implementar**

`src/app/api/usage/stats/route.js`: adicione `import { getResolvedUsageFilter } from "@/lib/db/repos/usageFilterRepo.js";` e troque `const stats = await getUsageStats(period);` por:

```js
    const stats = await getUsageStats(period, await getResolvedUsageFilter());
```

`src/app/api/usage/chart/route.js`: mesmo import, e troque `const data = await getChartData(period);` por:

```js
    const data = await getChartData(period, await getResolvedUsageFilter());
```

`src/app/api/usage/stream/route.js`: adicione o mesmo import. Dentro de `state.send`, troque:

```js
          if (state.cachedStats) {
            const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
```

por:

```js
          const resolved = await getResolvedUsageFilter();
          if (state.cachedStats) {
            const { activeRequests, recentRequests, errorProvider } = await getActiveRequests(resolved);
```

e `const stats = await getUsageStats();` por `const stats = await getUsageStats("all", resolved);`. Em `state.sendPending`, troque `await getActiveRequests();` por `await getActiveRequests(await getResolvedUsageFilter());`.

Em `src/lib/db/repos/usageRepo.js`:
- adicione `matchesUsageFilter` ao import de `../../usageFilter.js`
- troque `export async function getActiveRequests() {` por `export async function getActiveRequests(resolvedFilter = null) {`
- dentro do laço de `activeRequests`, logo depois de `const match = modelKey.match(...)`, troque o `activeRequests.push({...})` por:

```js
        const provider = match ? match[2] : "unknown";
        // In-flight tracking has no API key: only the provider dimension applies here.
        if (resolvedFilter?.providers && !resolvedFilter.providers.has(provider.toLowerCase())) continue;
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider,
          account: accountName, count,
        });
```

- em `recentRequests`, logo depois de `[...recentRing.items]`, insira `.filter((e) => matchesUsageFilter(resolvedFilter, e))` antes do `.sort(...)`. Isso também esconde linhas meta sem filtro, porque `matchesUsageFilter(null, …)` só aceita `work`.
- no `.map` de `recentRequests`, adicione `endpoint: e.endpoint, httpStatus: e.httpStatus ?? null, kind: e.kind || "work",`; troque o `.filter((e) => { ... })` que descarta 0 tokens e deduplica por minuto pelo mesmo bloco da Task 5:

```js
    // Every row is a real request now (errors and media carry zero tokens); only drop exact duplicates.
    .filter((e) => {
      const key = `${e.timestamp}|${e.model}|${e.provider}|${e.endpoint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/usage-filter-routes.test.js unit/usage-filter-stats.test.js unit/usage-filter-chart.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/usage/stats/route.js src/app/api/usage/chart/route.js src/app/api/usage/stream/route.js src/lib/db/repos/usageRepo.js tests/unit/usage-filter-routes.test.js
git commit -m "feat(usage): apply the saved filter in stats, chart and live stream

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Registro universal — família chat (chat/messages/responses/v1beta)

**Files:**
- Modify (embrulhar `POST`): `src/app/api/v1/chat/completions/route.js`, `src/app/api/v1/messages/route.js`, `src/app/api/v1/responses/route.js`, `src/app/api/v1/responses/compact/route.js`, `src/app/api/v1/api/chat/route.js`, `src/app/api/v1beta/models/[...path]/route.js`
- Modify: `src/sse/handlers/chat.js`
- Modify: `open-sse/handlers/chatCore/requestDetail.js` (`saveUsageStats`, novo `createUsageSaver`)
- Modify: `open-sse/handlers/chatCore.js`, `open-sse/handlers/chatCore/nonStreamingHandler.js`, `open-sse/handlers/chatCore/sseToJsonHandler.js`, `open-sse/handlers/chatCore/streamingHandler.js`
- Test: `tests/unit/chat-usage-recording.test.js`

**Interfaces:**
- Consumes: `withRequestUsage`, `currentRequestUsage` (Task 4).
- Produces:
  - `saveUsageStats({ ..., status = "ok" })` grava **sempre** (tokens 0 quando o provider não informou), com `httpStatus` 200 (ou 499 se `status: "aborted"`) e `kind: "work"`.
  - `createUsageSaver(): (args) => void` — chama `saveUsageStats` só na primeira vez.
  - Cada request de chat gera uma linha: sucesso → `chatCore` (com tokens); erro → wrapper (com provider/modelo/conta da última tentativa); cliente desconectou no meio → `"aborted"`.

**Padrão para embrulhar uma rota** (use em todas as rotas desta tarefa e das Tasks 9 e 10): renomeie a função exportada e exporte a versão embrulhada no fim do arquivo. `OPTIONS` não é embrulhado.

```js
// antes
export async function POST(request) {
  ...
}

// depois
import { withRequestUsage } from "@/lib/requestUsage.js";

async function handlePost(request) {
  ...
}

export const POST = withRequestUsage(handlePost);
```

Mantenha a assinatura original (por exemplo `handlePost(request, { params })` no v1beta). Para `GET`, use `handleGet` e `export const GET = withRequestUsage(handleGet);`. Se o próprio arquivo chamar `POST(`/`GET(` em outro lugar, troque pela função interna.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/chat-usage-recording.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  handleChatCore: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => "client-key",
  isValidApiKey: async () => true,
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    const [provider, ...rest] = m.split("/");
    return rest.length ? { provider, model: rest.join("/") } : { provider: null, model: m };
  },
  getComboModels: async () => null,
}));
vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("../../open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(), handleFusionChat: vi.fn(), detectRequiredCapabilities: () => new Set(),
}));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: (k) => k,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("../../open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));

const { saveUsageStats, createUsageSaver } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { withRequestUsage } = await import("../../src/lib/requestUsage.js");
const POST = withRequestUsage(handleChat);

const chatRequest = (body) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer client-key", "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "A", providerSpecificData: {} });
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});

describe("chat usage rows from chatCore", () => {
  it("records a success without provider usage as a zero-token row", () => {
    saveUsageStats({ provider: "openai", model: "gpt-x", tokens: null, connectionId: "c1", apiKey: "k", endpoint: "/v1/chat/completions", silent: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai", model: "gpt-x", tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok", httpStatus: 200, kind: "work",
    }));
  });

  it("records one row when completion and abort race", () => {
    const abortFirst = createUsageSaver();
    abortFirst({ provider: "openai", model: "gpt-x", tokens: null, silent: true, status: "aborted" });
    abortFirst({ provider: "openai", model: "gpt-x", tokens: { prompt_tokens: 5, completion_tokens: 1 }, silent: true });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(mocks.saveRequestUsage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "aborted", httpStatus: 499 }));

    const completeFirst = createUsageSaver();
    completeFirst({ provider: "openai", model: "gpt-x", tokens: { prompt_tokens: 5, completion_tokens: 1 }, silent: true });
    completeFirst({ provider: "openai", model: "gpt-x", tokens: null, silent: true, status: "aborted" });
    expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(2);
    expect(mocks.saveRequestUsage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", httpStatus: 200 }));
  });
});

describe("chat requests through the route wrapper", () => {
  it("leaves the success row to chatCore", async () => {
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok") });
    const res = await POST(chatRequest({ model: "openai/gpt-x", messages: [] }));
    expect(res.status).toBe(200);
    await settle();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("records a provider failure with provider, model and account", async () => {
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 503, error: "down", response: Response.json({ error: "down" }, { status: 503 }) });
    const res = await POST(chatRequest({ model: "openai/gpt-x", messages: [] }));
    expect(res.status).toBe(503);
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "openai", model: "gpt-x", connectionId: "conn-1", apiKey: "client-key",
      endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "error", httpStatus: 503, kind: "work",
    });
  });

  it("records invalid JSON", async () => {
    const res = await POST(chatRequest("{not json"));
    expect(res.status).toBe(400);
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "unknown", model: "unknown", httpStatus: 400, status: "error" }));
  });

  it("records a request with no usable account", async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    const res = await POST(chatRequest({ model: "openai/gpt-x", messages: [] }));
    expect(res.status).toBe(404);
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "gpt-x", connectionId: null, httpStatus: 404 }));
  });
});
```

Se o import de `chat.js` falhar por causa de alguma dependência pesada que não está no mock, adicione um `vi.mock` desse módulo devolvendo só os nomes que `chat.js` importa dele. Confira com `sed -n 1,30p src/sse/handlers/chat.js`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/chat-usage-recording.test.js`
Expected: FAIL. `createUsageSaver` não existe, `saveUsageStats` ignora `tokens: null` e o handler não registra falhas.

- [ ] **Step 3: `saveUsageStats` e `createUsageSaver`**

Em `open-sse/handlers/chatCore/requestDetail.js`, substitua a função `saveUsageStats` inteira por:

```js
export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", silent = false, status = "ok" }) {
  const hasTokens = !!tokens && typeof tokens === "object";
  const inTokens = hasTokens ? (tokens.input_tokens ?? tokens.prompt_tokens ?? 0) : 0;
  const outTokens = hasTokens ? (tokens.output_tokens ?? tokens.completion_tokens ?? 0) : 0;

  if (!silent && (inTokens || outTokens)) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Every finished request is a row, even when the provider reported no usage.
  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = !hasTokens
    ? { prompt_tokens: 0, completion_tokens: 0 }
    : canonicalizeUsage(tokens) || {
      prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
      completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
    };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    status,
    // 499 = client closed the request before the response finished (nginx convention).
    httpStatus: status === "aborted" ? 499 : 200,
    kind: "work",
  }).catch(() => {});
}

// One usage row per upstream attempt: stream completion and client abort can race.
export function createUsageSaver() {
  let saved = false;
  return (args) => {
    if (saved) return;
    saved = true;
    saveUsageStats(args);
  };
}
```

- [ ] **Step 4: `chatCore` grava uma vez só e registra abort**

Em `open-sse/handlers/chatCore.js`:
- no import de `./chatCore/requestDetail.js`, adicione `createUsageSaver`: `import { buildRequestDetail, extractRequestConfig, createUsageSaver } from "./chatCore/requestDetail.js";`
- logo antes de `const streamController = createStreamController({`, adicione `const saveUsage = createUsageSaver();`
- no `onDisconnect` desse `createStreamController`, depois de `trackPendingRequest(model, provider, connectionId, false);`, adicione:

```js
      // Client left before the response finished: still exactly one row, marked aborted.
      saveUsage({ provider, model, tokens: null, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true, status: "aborted" });
```

- no objeto `const sharedCtx = { ... }`, adicione `saveUsage` (por exemplo logo depois de `apiKey,`).

Em `open-sse/handlers/chatCore/nonStreamingHandler.js` (`handleNonStreamingResponse`), `open-sse/handlers/chatCore/sseToJsonHandler.js` (`handleForcedSSEToJson`, duas chamadas) e `open-sse/handlers/chatCore/streamingHandler.js` (`buildOnStreamComplete`):
- adicione `saveUsage = saveUsageStats` na desestruturação dos parâmetros da função. O default mantém funcionando quem chamar sem `saveUsage`.
- troque cada `saveUsageStats({` dentro dessas funções por `saveUsage({`.

Confira: `grep -n "saveUsageStats(\|saveUsage(" open-sse/handlers/chatCore*.js open-sse/handlers/chatCore/*.js`. Só a definição em `requestDetail.js` e o `createUsageSaver` podem chamar `saveUsageStats(` diretamente.

- [ ] **Step 5: `chat.js` enriquece o registro**

Em `src/sse/handlers/chat.js`:
- adicione `import { currentRequestUsage } from "@/lib/requestUsage.js";`
- em `handleChat`, logo depois de `if (contextMarker) body.model = modelStr;`: `currentRequestUsage()?.set({ model: modelStr });`
- em `handleSingleModelChat`, logo depois de `const { provider, model } = modelInfo;`: `currentRequestUsage()?.set({ provider, model });`
- no laço, logo depois do bloco `if (!credentials || credentials.allRateLimited) { ... }`: `currentRequestUsage()?.set({ connectionId: credentials.connectionId });`
- troque `if (result.success) return result.response;` por:

```js
    if (result.success) {
      // chatCore writes the success row (with tokens) when the response completes.
      currentRequestUsage()?.handOff();
      return result.response;
    }
```

- [ ] **Step 6: Embrulhar as rotas da família chat**

Aplique o padrão do topo desta tarefa ao `POST` de: `src/app/api/v1/chat/completions/route.js`, `src/app/api/v1/messages/route.js`, `src/app/api/v1/responses/route.js`, `src/app/api/v1/responses/compact/route.js`, `src/app/api/v1/api/chat/route.js`, `src/app/api/v1beta/models/[...path]/route.js`.

- [ ] **Step 7: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/chat-usage-recording.test.js unit/gemini-native-endpoint.test.js unit/cached-token-e2e.test.js`
Expected: PASS. O `gemini-native-endpoint` continua passando: o wrapper é transparente e grava no `HOME` isolado.

Rode também os testes do motor de chat que importam esses arquivos:

```bash
cd tests && npx vitest run $(grep -rlE "chatCore|streamingHandler|nonStreamingHandler|sseToJsonHandler|requestDetail" unit translator --include=*.test.js | tr '\n' ' ')
```

Expected: só as falhas que já estavam na linha de base. Compare com `baseline.json` se houver dúvida.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/v1/chat/completions/route.js src/app/api/v1/messages/route.js src/app/api/v1/responses/route.js src/app/api/v1/responses/compact/route.js src/app/api/v1/api/chat/route.js "src/app/api/v1beta/models/[...path]/route.js" src/sse/handlers/chat.js open-sse/handlers/chatCore.js open-sse/handlers/chatCore/requestDetail.js open-sse/handlers/chatCore/nonStreamingHandler.js open-sse/handlers/chatCore/sseToJsonHandler.js open-sse/handlers/chatCore/streamingHandler.js tests/unit/chat-usage-recording.test.js
git commit -m "feat(usage): record every chat request, including failures and aborted streams

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Registro universal — mídia e ferramentas (TTS, STT, imagem, vídeo, embeddings, search, fetch, systemone)

**Files:**
- Modify (embrulhar `POST`): `src/app/api/v1/audio/speech/route.js`, `src/app/api/v1/audio/transcriptions/route.js`, `src/app/api/v1/embeddings/route.js`, `src/app/api/v1/images/generations/route.js`, `src/app/api/v1/videos/generations/route.js`, `src/app/api/v1/videos/edits/route.js`, `src/app/api/v1/videos/extensions/route.js`, `src/app/api/v1/search/route.js`, `src/app/api/v1/web/fetch/route.js`, `src/app/api/v1/systemone/route.js`
- Modify: `src/sse/handlers/{tts,stt,imageGeneration,videoGeneration,search,fetch,embeddings,systemone}.js`
- Modify: `tests/unit/embedding-usage-persistence.test.js`
- Test: `tests/unit/media-usage-recording.test.js`

**Interfaces:**
- Consumes: `withRequestUsage`, `currentRequestUsage` (Task 4); padrão de embrulho (Task 8).
- Produces: uma linha por requisição de mídia/ferramenta, com provider/modelo/conta resolvidos. Embeddings e systemone passam a gravar **sempre**: tokens exatos quando houver, senão 0. Antes, só gravavam com uso exato.

- [ ] **Step 1: Escrever o teste que falha (TTS como representante)**

Crie `tests/unit/media-usage-recording.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTtsCore: vi.fn(),
  saveRequestUsage: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  extractApiKey: () => "client-key",
  isValidApiKey: async () => true,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    const [provider, ...rest] = m.split("/");
    return { provider, model: rest.join("/") };
  },
  getComboModels: async () => null,
}));
vi.mock("../../open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("../../open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { withRequestUsage } = await import("../../src/lib/requestUsage.js");
const POST = withRequestUsage(handleTts);

const speak = (model) => POST(new Request("http://localhost/v1/audio/speech", {
  method: "POST",
  headers: { authorization: "Bearer client-key" },
  body: JSON.stringify({ model, input: "olá" }),
}));
const audio = () => ({ success: true, response: new Response("audio", { status: 200 }) });
const failure = (status = 502) => ({ success: false, status, error: "boom", response: Response.json({ error: "boom" }, { status }) });
const recorded = () => mocks.saveRequestUsage.mock.calls.map(([entry]) => entry);

describe("TTS requests through the route wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  it("records a successful no-auth request once", async () => {
    mocks.handleTtsCore.mockResolvedValue(audio());
    expect((await speak("edge-tts/pt-BR-ThalitaMultilingualNeural")).status).toBe(200);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toEqual({
      provider: "edge-tts", model: "pt-BR-ThalitaMultilingualNeural", connectionId: null, apiKey: "client-key",
      endpoint: "/v1/audio/speech", tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok", httpStatus: 200, kind: "work",
    });
  });

  it("records a failed no-auth request as error", async () => {
    mocks.handleTtsCore.mockResolvedValue(failure(502));
    expect((await speak("edge-tts/voice")).status).toBe(502);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "edge-tts", status: "error", httpStatus: 502 });
  });

  it("records only the final outcome of an account fallback", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "conn-1", connectionName: "A" })
      .mockResolvedValueOnce({ connectionId: "conn-2", connectionName: "B" });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleTtsCore.mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(audio());
    expect((await speak("elevenlabs/voice-id")).status).toBe(200);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "elevenlabs", connectionId: "conn-2", status: "ok" });
  });

  it("records the last tried account when every account fails", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "conn-1", connectionName: "A" })
      .mockResolvedValueOnce(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleTtsCore.mockResolvedValueOnce(failure(500));
    await speak("elevenlabs/voice-id");
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ connectionId: "conn-1", status: "error" });
  });

  it("records the failure even when no account was available", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(null);
    expect((await speak("elevenlabs/voice-id")).status).toBe(400);
    await vi.waitFor(() => expect(recorded()).toHaveLength(1));
    expect(recorded()[0]).toMatchObject({ provider: "elevenlabs", connectionId: null, httpStatus: 400 });
  });

  it("audio still succeeds when saving usage fails", async () => {
    mocks.saveRequestUsage.mockRejectedValue(new Error("db down"));
    mocks.handleTtsCore.mockResolvedValue(audio());
    expect((await speak("edge-tts/voice")).status).toBe(200);
  });
});
```

Atualize `tests/unit/embedding-usage-persistence.test.js` para o novo comportamento:
- logo depois de `import { handleEmbeddings } from "../../src/sse/handlers/embeddings.js";` adicione:

```js
import { withRequestUsage } from "../../src/lib/requestUsage.js";

const embed = (body) => withRequestUsage(handleEmbeddings)(new Request("http://localhost/v1/embeddings", {
  method: "POST",
  headers: { authorization: "Bearer client-key" },
  body: JSON.stringify(body),
}));
```

- nos dois testes, troque `await handleEmbeddings(new Request(..., { method: "POST", body: JSON.stringify({ ... }) }));` por `await embed({ model: "openai/text-embedding-3-small", input: "hello" });`
- no teste de sucesso, troque o `expect(...)` por:

```js
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "connection-a",
      apiKey: "client-key",
      endpoint: "/v1/embeddings",
      tokens: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
      status: "ok",
      httpStatus: 200,
      kind: "work",
    });
```

- renomeie `"does not record inexact usage %#"` para `"records inexact usage as a zero-token request %#"` e troque o `expect(mocks.saveRequestUsage).not.toHaveBeenCalled();` por:

```js
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledTimes(1));
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok",
    }));
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/media-usage-recording.test.js unit/embedding-usage-persistence.test.js`
Expected: FAIL. `provider`/`model` vêm como `"unknown"` porque o handler ainda não enriquece o registro, e embeddings grava `status: "success"` direto.

- [ ] **Step 3: Enriquecer os handlers**

Em cada arquivo abaixo, adicione `import { currentRequestUsage } from "@/lib/requestUsage.js";` e as chamadas indicadas. Elas são no-op fora de uma requisição embrulhada, então os testes que chamam o handler direto continuam funcionando.

| Arquivo | Onde | Chamada |
|---|---|---|
| `tts.js` | em `handleTts`, logo depois de `if (!body.input) return ...` | `currentRequestUsage()?.set({ model: modelStr });` |
| `tts.js` | em `handleSingleModelTts`, depois de `const { provider, model } = modelInfo;` | `currentRequestUsage()?.set({ provider, model });` |
| `tts.js` | no laço, depois do bloco `if (!credentials \|\| credentials.allRateLimited) { ... }` | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `stt.js` | depois de `const { provider, model } = modelInfo;` | `currentRequestUsage()?.set({ provider, model });` |
| `stt.js` | no laço, depois do bloco `if (!credentials \|\| credentials.allRateLimited) { ... }` | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `imageGeneration.js` | depois de `const { provider, model } = modelInfo;` | `currentRequestUsage()?.set({ provider, model });` |
| `imageGeneration.js` | no laço, depois do bloco de credenciais indisponíveis | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `videoGeneration.js` | em `handleVideoCreate`, depois de `const { provider, model } = resolved;` | `currentRequestUsage()?.set({ provider, model });` |
| `videoGeneration.js` | no laço de `handleVideoCreate`, depois do bloco de credenciais indisponíveis | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `videoGeneration.js` | em `handleVideoGet`, depois de `const provider = await resolveGetProvider(...)` | `currentRequestUsage()?.set({ provider });` |
| `search.js` | depois de validar que `providerId` suporta busca (logo após o `return errorResponse(... does not support web search)`) | `currentRequestUsage()?.set({ provider: providerId, model: providerInput });` |
| `search.js` | no laço, depois do bloco de credenciais indisponíveis | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `fetch.js` | depois de validar que `providerId` suporta fetch | `currentRequestUsage()?.set({ provider: providerId, model: providerInput });` |
| `fetch.js` | no laço, depois do bloco de credenciais indisponíveis | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `embeddings.js` | depois de `const { provider, model } = modelInfo;` | `currentRequestUsage()?.set({ provider, model });` |
| `embeddings.js` | no laço, depois do bloco de credenciais indisponíveis | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |
| `systemone.js` | depois de `const { provider, model } = modelInfo;` | `currentRequestUsage()?.set({ provider, model });` |
| `systemone.js` | no laço, depois do bloco de credenciais indisponíveis | `currentRequestUsage()?.set({ connectionId: credentials.connectionId });` |

Em `embeddings.js`, troque o bloco de sucesso (o `if (usage) { saveRequestUsage({...}).catch(() => {}); }`) por:

```js
      const usage = exactEmbeddingUsage(result.usage);
      // The route wrapper writes the row; exact usage only when the provider reported it.
      if (usage) currentRequestUsage()?.set({ tokens: usage });
      return result.response;
```

Remova `import { saveRequestUsage } from "@/lib/usageDb.js";` de `embeddings.js`.

Em `systemone.js`, troque o bloco `if (result.usage) { saveRequestUsage({...}).catch(() => {}); }` por:

```js
      if (result.usage) {
        currentRequestUsage()?.set({
          tokens: { ...result.usage, total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens },
        });
      }
```

e remova o import de `saveRequestUsage` de `systemone.js`. Os nomes de variáveis da tabela (`credentials`, `providerId`, `providerInput`, `resolved`) já existem nesses arquivos. Confira cada ponto com `grep -n` antes de editar.

- [ ] **Step 4: Embrulhar as rotas**

Aplique o padrão da Task 8 ao `POST` de: `audio/speech`, `audio/transcriptions`, `embeddings`, `images/generations`, `videos/generations`, `videos/edits`, `videos/extensions`, `search`, `web/fetch`, `systemone` (todos em `src/app/api/v1/`).

- [ ] **Step 5: Rodar e ver passar**

Run:

```bash
cd tests && npx vitest run unit/media-usage-recording.test.js unit/embedding-usage-persistence.test.js unit/gemini-tts.test.js unit/gemini-live-stt.test.js unit/image-generation.test.js unit/huggingface-image-end-to-end.test.js unit/v1m-systemone-provider.test.js unit/xquik-search-provider.test.js unit/jina-reader-fetch.test.js unit/ollama-web-fetch-provider.test.js unit/tinyfish-web-provider.test.js unit/fetch-success-clears-account.test.js
```

Expected: PASS, exceto falhas que já estavam na linha de base.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/v1 src/sse/handlers tests/unit/media-usage-recording.test.js tests/unit/embedding-usage-persistence.test.js
git commit -m "feat(usage): record every media and tool request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Registro universal — metadados e recusas do guard

**Files:**
- Modify (embrulhar `GET`): `src/app/api/v1/models/route.js`, `src/app/api/v1/models/[...model]/route.js`, `src/app/api/v1/models/info/route.js`, `src/app/api/v1/audio/voices/route.js`, `src/app/api/v1/videos/[id]/route.js`, `src/app/api/v1beta/models/route.js`
- Modify (embrulhar `POST`): `src/app/api/v1/messages/count_tokens/route.js`
- Modify: `src/dashboardGuard.js`
- Modify: `tests/unit/dashboard-guard.test.js`
- Test: `tests/unit/request-usage-coverage.test.js`

**Interfaces:**
- Consumes: `withRequestUsage`, `recordRejectedRequest` (Task 4).
- Produces: linhas `kind: "meta"` para metadados; linha `httpStatus: 401` para cada requisição à API pública recusada pelo guard. Teste de cobertura que falha se alguma rota `/v1*` nova ficar sem wrapper.

`src/app/api/v1/route.js` só re-exporta `GET` de `./models/route`, então fica coberto automaticamente (endpoint `/v1` → meta).

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/unit/request-usage-coverage.test.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const API_ROOT = new URL("../../src/app/api/", import.meta.url).pathname;

function routeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.js" ? [full] : [];
  });
}

const files = ["v1", "v1beta"].flatMap((d) => routeFiles(path.join(API_ROOT, d)));

describe("every public API route records usage", () => {
  it("found the route files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [path.relative(API_ROOT, f), f]))("%s", (_rel, file) => {
    const src = fs.readFileSync(file, "utf8");
    // Re-export-only files (v1/route.js) inherit the wrapper from their source.
    if (/^export \{[^}]*\} from /m.test(src) && !/export (async )?function/.test(src)) return;
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
    expect(src).not.toMatch(/export\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
    expect(src).toMatch(/withRequestUsage\(/);
  });
});
```

Em `tests/unit/dashboard-guard.test.js`:
- em `vi.hoisted`, adicione `recordRejectedRequest: vi.fn(),`
- logo depois do `vi.mock("@/lib/auth/dashboardSession", ...)`, adicione:

```js
vi.mock("@/lib/requestUsage.js", () => ({
  recordRejectedRequest: mocks.recordRejectedRequest,
}));
```

- no fim do `describe("dashboard guard public LLM API access", ...)`, adicione:

```js
  it("records public API requests it rejects", async () => {
    const rejected = request("/v1/chat/completions", { host: "router.example.com", authorization: "Bearer sk-wrong" });
    const response = await proxy(rejected);

    expect(response.status).toBe(401);
    expect(mocks.recordRejectedRequest).toHaveBeenCalledWith(rejected, 401);
  });

  it("does not record allowed requests at the guard", async () => {
    await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128" }));
    expect(mocks.recordRejectedRequest).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/request-usage-coverage.test.js unit/dashboard-guard.test.js`
Expected: FAIL. As rotas de metadados ainda exportam `async function GET`, e o guard não chama `recordRejectedRequest`.

- [ ] **Step 3: Embrulhar as rotas de metadados**

Aplique o padrão da Task 8 (`handleGet`/`handlePost`) a: `v1/models/route.js` (`GET`), `v1/models/[...model]/route.js` (`GET`), `v1/models/info/route.js` (`GET`), `v1/audio/voices/route.js` (`GET`), `v1/videos/[id]/route.js` (`GET`), `v1beta/models/route.js` (`GET`), `v1/messages/count_tokens/route.js` (`POST`).

Atenção: `v1/models/route.js` também exporta `buildModelsList` e talvez outras funções usadas por outros módulos. Só renomeie o `GET`. Confira com `grep -rn "from \"./models/route\"\|models/route" src` que nenhum import de `GET` quebrou. O `v1/route.js` re-exporta `GET`, e isso continua funcionando com `export const GET`.

- [ ] **Step 4: Guard registra recusas**

Em `src/dashboardGuard.js`:
- adicione `import { recordRejectedRequest } from "@/lib/requestUsage.js";`
- no bloco da API pública:

```js
  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    // Refused before any route runs: still one usage row (the key, if any, shows as unknown).
    recordRejectedRequest(request, 401);
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }
```

Não mude a extração nem a validação de chave do guard (`extractApiKey`, `hasValidApiKey`), que são sensíveis a segurança. Só o registro é novo.

- [ ] **Step 5: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/request-usage-coverage.test.js unit/dashboard-guard.test.js unit/gemini-native-endpoint.test.js`
Expected: PASS. Se o coverage apontar uma rota que você não esperava (rota nova do upstream), embrulhe-a também.

Run (raiz): `npm run build 2>&1 | tail -20`
Expected: build sem erros. O `proxy` do Next 16 roda em Node, e `node:async_hooks` funciona nele. Se o build reclamar de `node:async_hooks` no bundle do proxy, troque o import estático no guard por `import("@/lib/requestUsage.js").then((m) => m.recordRejectedRequest(request, 401)).catch(() => {});`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/v1 src/app/api/v1beta src/dashboardGuard.js tests/unit/request-usage-coverage.test.js tests/unit/dashboard-guard.test.js
git commit -m "feat(usage): record metadata requests and guard rejections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: UI do filtro (estado, hook, barra, seletor de tipo, integração na página)

**Files:**
- Create: `src/app/(dashboard)/dashboard/usage/components/usageFilterState.js`
- Create: `src/app/(dashboard)/dashboard/usage/components/useUsageFilter.js`
- Create: `src/app/(dashboard)/dashboard/usage/components/UsageFilterBar.js`
- Modify: `src/app/(dashboard)/dashboard/usage/page.js`
- Modify: `src/shared/components/UsageStats.js`
- Modify: `src/app/(dashboard)/dashboard/usage/components/UsageChart.js`
- Test: `tests/unit/usage-filter-ui-state.test.js`

**Interfaces:**
- Consumes: `GET/PUT /api/usage/filter` (Task 3), `KEY_NONE`, `KEY_UNKNOWN`, `DEFAULT_USAGE_FILTER`, `isUsageFilterActive` (Task 2); `recentRequests[i].endpoint/httpStatus` (Task 5).
- Produces (`usageFilterState.js`): `apiKeyOptionIds(options)`, `toggleProvider(filter, id, allIds)`, `toggleApiKey(filter, id, allIds)`, `toggleTag(filter, tag)`, `selectAllSection(filter, section)`, `clearSection(filter, section)`, `onlyApiKey(filter, id)`, `onlyTag(filter, tag)`, `setRequestKind(filter, kind)`, `summarizeProviders(filter, options)`, `summarizeApiKeys(filter, options)`. Todas são puras e retornam um filtro novo ou uma string.
- Produces (`useUsageFilter()`): `{ filter, options, setFilter(next), version: number, syncError: string, loaded: boolean }`. `version` incrementa a cada PUT bem-sucedido.
- Produces: `UsageStats` aceita `filterVersion`, `filter`, `setFilter`. `UsageChart` aceita `refreshKey`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/usage-filter-ui-state.test.js`:

```js
import { describe, it, expect } from "vitest";
import { DEFAULT_USAGE_FILTER, KEY_NONE, KEY_UNKNOWN } from "../../src/lib/usageFilter.js";
import {
  apiKeyOptionIds, toggleProvider, toggleApiKey, toggleTag, selectAllSection, clearSection,
  onlyApiKey, onlyTag, setRequestKind, summarizeProviders, summarizeApiKeys,
} from "../../src/app/(dashboard)/dashboard/usage/components/usageFilterState.js";

const options = {
  providers: [{ id: "openai", label: "OpenAI" }, { id: "edge-tts", label: "Edge TTS" }],
  apiKeys: [{ id: "a", name: "Alpha", isActive: true, tags: ["clientes"] }, { id: "b", name: "Beta", isActive: true, tags: [] }],
  tags: ["clientes"],
};

describe("usage filter UI transitions", () => {
  it("lists special key options after real keys", () => {
    expect(apiKeyOptionIds(options)).toEqual(["a", "b", KEY_NONE, KEY_UNKNOWN]);
  });

  it("unchecking in all mode keeps everything else", () => {
    const f = toggleProvider(DEFAULT_USAGE_FILTER, "openai", ["openai", "edge-tts"]);
    expect(f.providers).toEqual({ mode: "selected", ids: ["edge-tts"] });
    const k = toggleApiKey(DEFAULT_USAGE_FILTER, "a", apiKeyOptionIds(options));
    expect(k.apiKeys).toEqual({ mode: "selected", ids: ["b", KEY_NONE, KEY_UNKNOWN], tags: [] });
  });

  it("toggling twice restores membership", () => {
    const once = toggleApiKey(onlyApiKey(DEFAULT_USAGE_FILTER, "a"), "b", apiKeyOptionIds(options));
    expect(once.apiKeys.ids).toEqual(["a", "b"]);
    expect(toggleApiKey(once, "b", apiKeyOptionIds(options)).apiKeys.ids).toEqual(["a"]);
  });

  it("checking a tag in all mode narrows to that tag", () => {
    expect(toggleTag(DEFAULT_USAGE_FILTER, "clientes").apiKeys).toEqual({ mode: "selected", ids: [], tags: ["clientes"] });
    expect(onlyTag(DEFAULT_USAGE_FILTER, "clientes").apiKeys).toEqual({ mode: "selected", ids: [], tags: ["clientes"] });
  });

  it("switches request kind and keeps it across other changes", () => {
    const meta = setRequestKind(DEFAULT_USAGE_FILTER, "meta");
    expect(meta.requestKind).toBe("meta");
    expect(onlyApiKey(meta, "a").requestKind).toBe("meta");
    expect(selectAllSection(meta, "providers").requestKind).toBe("meta");
  });

  it("select all and clear", () => {
    const narrowed = onlyApiKey(DEFAULT_USAGE_FILTER, "a");
    expect(selectAllSection(narrowed, "apiKeys").apiKeys).toEqual({ mode: "all", ids: [], tags: [] });
    expect(clearSection(narrowed, "providers").providers).toEqual({ mode: "selected", ids: [] });
    expect(clearSection(narrowed, "apiKeys").apiKeys).toEqual({ mode: "selected", ids: [], tags: [] });
  });

  it("summaries", () => {
    expect(summarizeProviders(DEFAULT_USAGE_FILTER, options)).toBe("All");
    expect(summarizeProviders({ ...DEFAULT_USAGE_FILTER, providers: { mode: "selected", ids: ["openai"] } }, options)).toBe("OpenAI");
    expect(summarizeProviders(clearSection(DEFAULT_USAGE_FILTER, "providers"), options)).toBe("None");
    expect(summarizeApiKeys(onlyApiKey(DEFAULT_USAGE_FILTER, "a"), options)).toBe("Alpha");
    expect(summarizeApiKeys(onlyApiKey(DEFAULT_USAGE_FILTER, KEY_NONE), options)).toBe("No API key");
    expect(summarizeApiKeys(onlyApiKey(DEFAULT_USAGE_FILTER, "gone"), options)).toBe("Deleted key");
    expect(summarizeApiKeys(onlyTag(DEFAULT_USAGE_FILTER, "clientes"), options)).toBe("#clientes");
    expect(summarizeApiKeys({ ...DEFAULT_USAGE_FILTER, apiKeys: { mode: "selected", ids: ["a", "b"], tags: ["x"] } }, options)).toBe("2 keys + #x");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/usage-filter-ui-state.test.js`
Expected: FAIL com "Failed to resolve import ... usageFilterState.js".

- [ ] **Step 3: Implementar o estado puro**

Crie `src/app/(dashboard)/dashboard/usage/components/usageFilterState.js`:

```js
import { KEY_NONE, KEY_UNKNOWN } from "@/lib/usageFilter";

export function apiKeyOptionIds(options) {
  return [...(options?.apiKeys || []).map((k) => k.id), KEY_NONE, KEY_UNKNOWN];
}

function toggleIn(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set];
}

// In "all" mode every option is implicitly checked, so unchecking one keeps the rest.
export function toggleProvider(filter, id, allIds) {
  const current = new Set(filter.providers.mode === "all" ? allIds : filter.providers.ids);
  return { ...filter, providers: { mode: "selected", ids: toggleIn(current, id) } };
}

export function toggleApiKey(filter, id, allIds) {
  const s = filter.apiKeys;
  const current = new Set(s.mode === "all" ? allIds : s.ids);
  return { ...filter, apiKeys: { mode: "selected", ids: toggleIn(current, id), tags: s.mode === "all" ? [] : s.tags } };
}

// Tags are unchecked in "all" mode, so checking one narrows to that tag.
export function toggleTag(filter, tag) {
  const s = filter.apiKeys;
  const tags = new Set(s.mode === "all" ? [] : s.tags);
  return { ...filter, apiKeys: { mode: "selected", ids: s.mode === "all" ? [] : s.ids, tags: toggleIn(tags, tag) } };
}

export function selectAllSection(filter, section) {
  return { ...filter, [section]: section === "apiKeys" ? { mode: "all", ids: [], tags: [] } : { mode: "all", ids: [] } };
}

export function clearSection(filter, section) {
  return { ...filter, [section]: section === "apiKeys" ? { mode: "selected", ids: [], tags: [] } : { mode: "selected", ids: [] } };
}

export function onlyApiKey(filter, id) {
  return { ...filter, apiKeys: { mode: "selected", ids: [id], tags: [] } };
}

export function onlyTag(filter, tag) {
  return { ...filter, apiKeys: { mode: "selected", ids: [], tags: [tag] } };
}

export function setRequestKind(filter, requestKind) {
  return { ...filter, requestKind };
}

export function summarizeProviders(filter, options) {
  const s = filter.providers;
  if (s.mode === "all") return "All";
  if (!s.ids.length) return "None";
  if (s.ids.length === 1) return options.providers.find((p) => p.id === s.ids[0])?.label || s.ids[0];
  return `${s.ids.length} selected`;
}

function keyLabel(id, options) {
  if (id === KEY_NONE) return "No API key";
  if (id === KEY_UNKNOWN) return "Unknown keys";
  return options.apiKeys.find((k) => k.id === id)?.name || "Deleted key";
}

export function summarizeApiKeys(filter, options) {
  const s = filter.apiKeys;
  if (s.mode === "all") return "All";
  if (s.ids.length === 1 && !s.tags.length) return keyLabel(s.ids[0], options);
  const parts = [];
  if (s.ids.length) parts.push(`${s.ids.length} key${s.ids.length > 1 ? "s" : ""}`);
  if (s.tags.length) parts.push(s.tags.map((t) => `#${t}`).join(" "));
  return parts.length ? parts.join(" + ") : "None";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/usage-filter-ui-state.test.js`
Expected: PASS.

- [ ] **Step 5: Implementar o hook e a barra**

Crie `src/app/(dashboard)/dashboard/usage/components/useUsageFilter.js`:

```js
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_USAGE_FILTER } from "@/lib/usageFilter";

const SAVE_DEBOUNCE_MS = 400;
const EMPTY_OPTIONS = { providers: [], apiKeys: [], tags: [] };

// Global (server-persisted) usage filter. `version` bumps after each successful
// save so data views know to refetch; the server applies the filter itself.
export default function useUsageFilter() {
  const [filter, setFilterState] = useState(DEFAULT_USAGE_FILTER);
  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [version, setVersion] = useState(0);
  const [syncError, setSyncError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage/filter", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setFilterState(data.filter);
        setOptions(data.options || EMPTY_OPTIONS);
      })
      .catch(() => !cancelled && setSyncError("Could not load the saved filter."))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, []);

  const setFilter = useCallback((next) => {
    setFilterState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/usage/filter", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSyncError("");
        setVersion((v) => v + 1);
      } catch {
        setSyncError("Could not save the filter. Change it again to retry.");
      }
    }, SAVE_DEBOUNCE_MS);
  }, []);

  return { filter, options, setFilter, version, syncError, loaded };
}
```

Crie `src/app/(dashboard)/dashboard/usage/components/UsageFilterBar.js`:

```js
"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { DEFAULT_USAGE_FILTER, KEY_NONE, KEY_UNKNOWN, isUsageFilterActive } from "@/lib/usageFilter";
import {
  apiKeyOptionIds, toggleProvider, toggleApiKey, toggleTag, setRequestKind,
  selectAllSection, clearSection, summarizeProviders, summarizeApiKeys,
} from "./usageFilterState";

const REQUEST_KIND_OPTIONS = [
  { value: "work", label: "Work" },
  { value: "meta", label: "Metadata" },
  { value: "all", label: "All" },
];

function FilterDropdown({ label, summary, onSelectAll, onClear, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1 text-sm font-medium text-text-main hover:bg-bg-hover"
      >
        <span className="text-text-muted">{label}:</span>
        <span className="max-w-[140px] truncate">{summary}</span>
        <span className="material-symbols-outlined text-[16px]">expand_more</span>
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-96 w-72 overflow-y-auto rounded-lg border border-border bg-surface p-2 shadow-lg sm:left-auto sm:right-0">
          <div className="mb-1 flex justify-between px-2 text-xs">
            <button type="button" onClick={onSelectAll} className="text-primary hover:underline">Select all</button>
            <button type="button" onClick={onClear} className="text-text-muted hover:underline">Clear</button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

FilterDropdown.propTypes = {
  label: PropTypes.string.isRequired,
  summary: PropTypes.string.isRequired,
  onSelectAll: PropTypes.func.isRequired,
  onClear: PropTypes.func.isRequired,
  children: PropTypes.node,
};

function CheckRow({ checked, onChange, label, hint = "" }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg-hover">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="truncate">{label}</span>
      {hint && <span className="ml-auto shrink-0 text-[10px] text-text-muted">{hint}</span>}
    </label>
  );
}

CheckRow.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string.isRequired,
  hint: PropTypes.string,
};

const SectionTitle = ({ children }) => (
  <p className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{children}</p>
);

export default function UsageFilterBar({ filter, options, setFilter, syncError = "" }) {
  const providerIds = options.providers.map((p) => p.id);
  const keyIds = apiKeyOptionIds(options);
  const keys = filter.apiKeys;
  const keyChecked = (id) => keys.mode === "all" || keys.ids.includes(id);
  const viaTag = (k) => keys.mode === "selected" && !keys.ids.includes(k.id) && k.tags.some((t) => keys.tags.includes(t));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterDropdown
        label="Providers"
        summary={summarizeProviders(filter, options)}
        onSelectAll={() => setFilter(selectAllSection(filter, "providers"))}
        onClear={() => setFilter(clearSection(filter, "providers"))}
      >
        {!options.providers.length && <p className="px-2 py-1 text-xs text-text-muted">No providers yet.</p>}
        {options.providers.map((p) => (
          <CheckRow
            key={p.id}
            label={p.label}
            checked={filter.providers.mode === "all" || filter.providers.ids.includes(p.id)}
            onChange={() => setFilter(toggleProvider(filter, p.id, providerIds))}
          />
        ))}
      </FilterDropdown>

      <FilterDropdown
        label="API Keys"
        summary={summarizeApiKeys(filter, options)}
        onSelectAll={() => setFilter(selectAllSection(filter, "apiKeys"))}
        onClear={() => setFilter(clearSection(filter, "apiKeys"))}
      >
        <SectionTitle>Keys</SectionTitle>
        {options.apiKeys.map((k) => (
          <CheckRow
            key={k.id}
            label={k.isActive ? k.name : `${k.name} (paused)`}
            checked={keyChecked(k.id) || viaTag(k)}
            hint={viaTag(k) ? "via tag" : ""}
            onChange={() => setFilter(toggleApiKey(filter, k.id, keyIds))}
          />
        ))}
        <CheckRow label="No API key" checked={keyChecked(KEY_NONE)} onChange={() => setFilter(toggleApiKey(filter, KEY_NONE, keyIds))} />
        <CheckRow label="Unknown / deleted keys" checked={keyChecked(KEY_UNKNOWN)} onChange={() => setFilter(toggleApiKey(filter, KEY_UNKNOWN, keyIds))} />
        {options.tags.length > 0 && (
          <>
            <SectionTitle>Tags</SectionTitle>
            {options.tags.map((t) => (
              <CheckRow
                key={t}
                label={`#${t}`}
                checked={keys.mode === "selected" && keys.tags.includes(t)}
                onChange={() => setFilter(toggleTag(filter, t))}
              />
            ))}
          </>
        )}
      </FilterDropdown>

      <SegmentedControl
        options={REQUEST_KIND_OPTIONS}
        value={filter.requestKind || "work"}
        onChange={(kind) => setFilter(setRequestKind(filter, kind))}
        size="sm"
      />

      {isUsageFilterActive(filter) && (
        <button type="button" onClick={() => setFilter(DEFAULT_USAGE_FILTER)} className="text-xs text-primary hover:underline">
          Reset filters
        </button>
      )}
      {syncError && <span role="status" className="text-xs text-warning">{syncError}</span>}
    </div>
  );
}

UsageFilterBar.propTypes = {
  filter: PropTypes.object.isRequired,
  options: PropTypes.shape({
    providers: PropTypes.array.isRequired,
    apiKeys: PropTypes.array.isRequired,
    tags: PropTypes.array.isRequired,
  }).isRequired,
  setFilter: PropTypes.func.isRequired,
  syncError: PropTypes.string,
};
```

- [ ] **Step 6: Integrar na página, nos stats e no gráfico**

`src/app/(dashboard)/dashboard/usage/page.js`:
- imports:

```js
import useUsageFilter from "./components/useUsageFilter";
import UsageFilterBar from "./components/UsageFilterBar";
```

- em `UsageContent`, depois de `const [period, setPeriod] = useState("today");`: `const usageFilter = useUsageFilter();`
- troque o bloco `{activeTab === "overview" && (<SegmentedControl ... />)}` por:

```jsx
        {activeTab === "overview" && (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <UsageFilterBar
              filter={usageFilter.filter}
              options={usageFilter.options}
              setFilter={usageFilter.setFilter}
              syncError={usageFilter.syncError}
            />
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
          </div>
        )}
```

- troque `<UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />` por:

```jsx
          <UsageStats
            period={period}
            setPeriod={setPeriod}
            hidePeriodSelector
            filterVersion={usageFilter.version}
            filter={usageFilter.filter}
            setFilter={usageFilter.setFilter}
          />
```

`src/app/(dashboard)/dashboard/usage/components/UsageChart.js`:
- `export default function UsageChart({ period = "7d" }) {` → `export default function UsageChart({ period = "7d", refreshKey = 0 }) {`
- o `}, [period]);` do `useCallback` de `fetchData` (linha ~55) → `}, [period, refreshKey]);`
- em `UsageChart.propTypes`, adicione `refreshKey: PropTypes.number,`

`src/shared/components/UsageStats.js`:
- assinatura:

```js
export default function UsageStats({ period: periodProp, setPeriod: setPeriodProp, hidePeriodSelector = false, filterVersion = 0, filter = null, setFilter = null } = {}) {
```

- no efeito que busca `/api/usage/stats`, troque o `}, [period]);` (linha ~281, logo após o `.finally(...)`) por `}, [period, filterVersion]);`
- antes de `// Compute active table data`, adicione:

```js
  // Topology only shows the selected providers; the server already filters live activity by provider.
  const visibleProviders = useMemo(() => {
    if (filter?.providers?.mode !== "selected") return providers;
    const selected = new Set(filter.providers.ids);
    return providers.filter((p) => selected.has(String(p.provider || "").toLowerCase()));
  }, [providers, filter]);
  const keyFilterActive = filter?.apiKeys?.mode === "selected";
```

- no JSX da topologia, troque `providers={providers}` por `providers={visibleProviders}` e, logo depois do `</div>` que fecha o grid topologia + Recent Requests, adicione:

```jsx
      {!loading && keyFilterActive && (
        <p className="-mt-4 text-[11px] text-text-muted">Live activity on the topology is filtered by provider only.</p>
      )}
```

- troque `{loading ? spinner : <UsageChart period={period} />}` por `{loading ? spinner : <UsageChart period={period} refreshKey={filterVersion} />}`
- em `RecentRequests`, no `<tr key={i} className="hover:bg-bg-subtle transition-colors">`, adicione `title={[r.endpoint, r.httpStatus || r.status].filter(Boolean).join(" · ")}` para que o hover mostre o endpoint e o código. Agora a lista também tem erros e requisições sem tokens.

- [ ] **Step 7: Build e verificação**

Run (raiz do worktree): `npm run build 2>&1 | tail -20`
Expected: build sem erros. Se der erro de import de `@/lib/usageFilter` num client component, confira se o arquivo não importa nada de `node:`.

Run: `cd tests && npx vitest run unit/usage-filter-ui-state.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/dashboard/usage" src/shared/components/UsageStats.js tests/unit/usage-filter-ui-state.test.js
git commit -m "feat(usage): add provider and API key filter controls to the usage dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Card de ranking por chave/tag

**Files:**
- Create: `src/app/(dashboard)/dashboard/usage/components/apiKeyRanking.js`
- Create: `src/app/(dashboard)/dashboard/usage/components/ApiKeyRankingCard.js`
- Modify: `src/shared/components/UsageStats.js`
- Test: `tests/unit/api-key-ranking.test.js`

**Interfaces:**
- Consumes: `stats.byApiKey` (registros com `apiKeyId`, `keyName`) e `stats.apiKeyCatalog` (Task 5); `onlyApiKey`, `onlyTag` (Task 11); props `filter`/`setFilter` de `UsageStats` (Task 11).
- Produces: `buildApiKeyRanking(byApiKey, catalog, { groupBy: "key"|"tag", metric: "tokens"|"cost"|"requests" })` → `Row[]` com `{ id, label, tags, keyCount?, requests, promptTokens, completionTokens, cachedTokens, cost, totalTokens, value, share }`, ordenado por `value` desc, sem linhas zeradas. `UNTAGGED = "__untagged__"`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/unit/api-key-ranking.test.js`:

```js
import { describe, it, expect } from "vitest";
import { buildApiKeyRanking, UNTAGGED } from "../../src/app/(dashboard)/dashboard/usage/components/apiKeyRanking.js";

const rec = (apiKeyId, keyName, promptTokens, completionTokens, cost, requests) =>
  ({ apiKeyId, keyName, promptTokens, completionTokens, cachedTokens: 0, cost, requests });

const byApiKey = {
  "a|gpt|openai": rec("a", "Alpha", 100, 50, 1, 2),
  "a|claude|anthropic": rec("a", "Alpha", 50, 0, 2, 1),
  "b|gpt|openai": rec("b", "Beta", 10, 0, 5, 10),
  "__none__": rec("__none__", "Local (No API Key)", 0, 0, 0, 0),
};
const catalog = [
  { id: "a", name: "Alpha", isActive: true, tags: ["clientes", "time-x"] },
  { id: "b", name: "Beta", isActive: true, tags: [] },
];

describe("buildApiKeyRanking", () => {
  it("sums every model of a key and sorts by tokens", () => {
    const rows = buildApiKeyRanking(byApiKey, catalog, { groupBy: "key", metric: "tokens" });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ label: "Alpha", totalTokens: 200, value: 200, requests: 3, cost: 3, tags: ["clientes", "time-x"] });
    expect(rows[0].share).toBeCloseTo(200 / 210);
  });

  it("ranks by cost and requests", () => {
    expect(buildApiKeyRanking(byApiKey, catalog, { metric: "cost" }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(buildApiKeyRanking(byApiKey, catalog, { metric: "requests" }).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("groups by tag, counting multi-tag keys in each tag", () => {
    const rows = buildApiKeyRanking(byApiKey, catalog, { groupBy: "tag", metric: "tokens" });
    expect(rows.map((r) => r.id)).toEqual(["clientes", "time-x", UNTAGGED]);
    expect(rows[0]).toMatchObject({ value: 200, keyCount: 1 });
    expect(rows[2]).toMatchObject({ label: "(untagged)", value: 10, keyCount: 1 });
  });

  it("returns [] for no usage", () => {
    expect(buildApiKeyRanking({}, catalog)).toEqual([]);
    expect(buildApiKeyRanking(undefined, undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd tests && npx vitest run unit/api-key-ranking.test.js`
Expected: FAIL (import não resolvido).

- [ ] **Step 3: Implementar**

Crie `src/app/(dashboard)/dashboard/usage/components/apiKeyRanking.js`:

```js
import { KEY_NONE } from "@/lib/usageFilter";

export const UNTAGGED = "__untagged__";

const SUM_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];
const METRICS = {
  tokens: (r) => r.promptTokens + r.completionTokens,
  cost: (r) => r.cost,
  requests: (r) => r.requests,
};

function emptyRow(id, label, tags) {
  return { id, label, tags, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
}

function addInto(target, source) {
  for (const f of SUM_FIELDS) target[f] += source[f] || 0;
}

// byApiKey: redacted stats map ("<apiKeyId>|model|provider" → totals). catalog: stats.apiKeyCatalog.
export function buildApiKeyRanking(byApiKey = {}, catalog = [], { groupBy = "key", metric = "tokens" } = {}) {
  const byId = new Map((catalog || []).map((k) => [k.id, k]));
  const perKey = new Map();
  for (const rec of Object.values(byApiKey || {})) {
    const id = rec.apiKeyId || KEY_NONE;
    if (!perKey.has(id)) perKey.set(id, emptyRow(id, byId.get(id)?.name || rec.keyName || id, byId.get(id)?.tags || []));
    addInto(perKey.get(id), rec);
  }

  const value = METRICS[metric] || METRICS.tokens;
  // Keys without usage for this metric would inflate tag key counts; drop them first.
  const keyRows = [...perKey.values()].filter((r) => value(r) > 0);
  const total = keyRows.reduce((sum, r) => sum + value(r), 0);

  let rows = keyRows;
  if (groupBy === "tag") {
    const groups = new Map();
    for (const r of keyRows) {
      for (const tag of r.tags.length ? r.tags : [UNTAGGED]) {
        if (!groups.has(tag)) groups.set(tag, { ...emptyRow(tag, tag === UNTAGGED ? "(untagged)" : tag, []), keyCount: 0 });
        const g = groups.get(tag);
        g.keyCount += 1;
        addInto(g, r);
      }
    }
    rows = [...groups.values()];
  }

  return rows
    .map((r) => ({ ...r, totalTokens: r.promptTokens + r.completionTokens, value: value(r), share: total > 0 ? value(r) / total : 0 }))
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label));
}
```

Crie `src/app/(dashboard)/dashboard/usage/components/ApiKeyRankingCard.js`:

```js
"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { buildApiKeyRanking, UNTAGGED } from "./apiKeyRanking";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;
const fmtCount = (n) => new Intl.NumberFormat().format(n || 0);
const fmtPct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const FORMAT = { tokens: fmtTokens, cost: fmtCost, requests: fmtCount };

const GROUP_OPTIONS = [{ value: "key", label: "By key" }, { value: "tag", label: "By tag" }];
const METRIC_OPTIONS = [{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }, { value: "requests", label: "Requests" }];

export default function ApiKeyRankingCard({ byApiKey, catalog, onSelectKey, onSelectTag }) {
  const [groupBy, setGroupBy] = useState("key");
  const [metric, setMetric] = useState("tokens");
  const rows = useMemo(() => buildApiKeyRanking(byApiKey, catalog, { groupBy, metric }), [byApiKey, catalog, groupBy, metric]);
  const max = rows[0]?.value || 0;
  const format = FORMAT[metric];

  const clickable = (row) => (groupBy === "key" ? !!onSelectKey : !!onSelectTag && row.id !== UNTAGGED);
  const select = (row) => (groupBy === "key" ? onSelectKey(row.id) : onSelectTag(row.id));

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">API Key Ranking</span>
        <div className="flex flex-wrap gap-2">
          <SegmentedControl options={GROUP_OPTIONS} value={groupBy} onChange={setGroupBy} size="sm" />
          <SegmentedControl options={METRIC_OPTIONS} value={metric} onChange={setMetric} size="sm" />
        </div>
      </div>

      {!rows.length ? (
        <div className="py-8 text-center text-sm text-text-muted">No API key usage for this period.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                disabled={!clickable(row)}
                onClick={() => select(row)}
                title={clickable(row) ? "Show only this in the dashboard" : undefined}
                className="w-full rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-bg-hover disabled:cursor-default"
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{groupBy === "tag" && row.id !== UNTAGGED ? `#${row.label}` : row.label}</span>
                    {groupBy === "key" && row.tags.map((t) => (
                      <span key={t} className="shrink-0 rounded bg-bg-subtle px-1 text-[10px] text-text-muted">#{t}</span>
                    ))}
                    {groupBy === "tag" && (
                      <span className="shrink-0 text-[10px] text-text-muted">{row.keyCount} key{row.keyCount > 1 ? "s" : ""}</span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {format(row.value)} <span className="text-xs text-text-muted">· {fmtPct(row.share)}</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }} />
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-text-muted">
                  {fmtTokens(row.promptTokens)} in · {fmtTokens(row.cachedTokens)} cached · {fmtTokens(row.completionTokens)} out · {fmtCost(row.cost)} · {fmtCount(row.requests)} req
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {groupBy === "tag" && rows.length > 0 && (
        <p className="text-[11px] text-text-muted">Keys with several tags count in each tag, so percentages can add up to more than 100%.</p>
      )}
    </Card>
  );
}

ApiKeyRankingCard.propTypes = {
  byApiKey: PropTypes.object,
  catalog: PropTypes.array,
  onSelectKey: PropTypes.func,
  onSelectTag: PropTypes.func,
};
```

Em `src/shared/components/UsageStats.js`:
- imports:

```js
import ApiKeyRankingCard from "@/app/(dashboard)/dashboard/usage/components/ApiKeyRankingCard";
import { onlyApiKey, onlyTag } from "@/app/(dashboard)/dashboard/usage/components/usageFilterState";
```

- logo depois do bloco `{/* Provider and model breakdown charts */} ... </div> )}`, adicione:

```jsx
      {!loading && stats.byApiKey && (
        <ApiKeyRankingCard
          byApiKey={stats.byApiKey}
          catalog={stats.apiKeyCatalog || []}
          onSelectKey={setFilter && filter ? (id) => setFilter(onlyApiKey(filter, id)) : undefined}
          onSelectTag={setFilter && filter ? (tag) => setFilter(onlyTag(filter, tag)) : undefined}
        />
      )}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd tests && npx vitest run unit/api-key-ranking.test.js`
Expected: PASS.
Run (raiz): `npm run build 2>&1 | tail -20`
Expected: build sem erros.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/dashboard/usage/components/apiKeyRanking.js" "src/app/(dashboard)/dashboard/usage/components/ApiKeyRankingCard.js" src/shared/components/UsageStats.js tests/unit/api-key-ranking.test.js
git commit -m "feat(usage): add API key ranking card grouped by key or tag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Editor de tags na lista de API keys

**Files:**
- Modify: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`

**Interfaces:**
- Consumes: `parseTagInput` (Task 1), `PUT /api/keys/:id { tags }` (Task 1). `GET /api/keys` já devolve `tags` (Task 1).
- Produces: UI apenas.

O parse e a validação já estão testados na Task 1 (`parseTagInput`, PUT 400). Esta tarefa é só ligação de UI, verificada por build e smoke manual.

- [ ] **Step 1: Estado e handler**

Em `EndpointPageClient.js`:
- no import de `@/shared/components`, adicione `Badge`: `import { Card, Button, Input, Modal, CardSkeleton, Toggle, ConfirmModal, Badge } from "@/shared/components";`
- adicione `import { parseTagInput } from "@/lib/apiKeyTags";`
- logo depois de `const [keys, setKeys] = useState([]);`: `const [tagEditor, setTagEditor] = useState(null); // { id, name, text, error }`
- logo depois da função `handleToggleKey`, adicione:

```js
  const handleSaveTags = async () => {
    if (!tagEditor) return;
    let tags;
    try {
      tags = parseTagInput(tagEditor.text);
    } catch (error) {
      setTagEditor((s) => ({ ...s, error: error.message }));
      return;
    }
    try {
      const res = await fetch(`/api/keys/${tagEditor.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTagEditor((s) => ({ ...s, error: data.error || "Failed to save tags" }));
        return;
      }
      setKeys((prev) => prev.map((k) => (k.id === tagEditor.id ? { ...k, tags: data.key.tags } : k)));
      setTagEditor(null);
    } catch {
      setTagEditor((s) => ({ ...s, error: "Failed to save tags" }));
    }
  };
```

- [ ] **Step 2: Chips e botão na linha da chave**

Logo depois de `<p className="text-sm font-medium">{key.name}</p>`, adicione:

```jsx
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {(key.tags || []).map((t) => (
                      <Badge key={t} variant="default" size="sm">#{t}</Badge>
                    ))}
                    <button
                      type="button"
                      onClick={() => setTagEditor({ id: key.id, name: key.name, text: (key.tags || []).join(", "), error: "" })}
                      className="flex items-center gap-0.5 rounded px-1 text-xs text-text-muted hover:text-primary"
                      title="Edit tags"
                    >
                      <span className="material-symbols-outlined text-[14px]">sell</span>
                      {key.tags?.length ? "Edit" : "Add tags"}
                    </button>
                  </div>
```

- [ ] **Step 3: Modal**

Logo antes de `{/* Add Key Modal */}`, adicione:

```jsx
      {/* Edit Tags Modal */}
      <Modal isOpen={!!tagEditor} title={tagEditor ? `Tags · ${tagEditor.name}` : "Tags"} onClose={() => setTagEditor(null)}>
        <div className="flex flex-col gap-4">
          <Input
            label="Tags (comma separated)"
            value={tagEditor?.text || ""}
            onChange={(e) => setTagEditor((s) => ({ ...s, text: e.target.value, error: "" }))}
            placeholder="clientes, pessoal"
          />
          <p className="text-xs text-text-muted">Used to group keys in Usage filters and ranking. Up to 10 tags, 32 characters each.</p>
          {tagEditor?.error && <p className="text-xs text-red-500">{tagEditor.error}</p>}
          <div className="flex gap-2">
            <Button onClick={handleSaveTags} fullWidth>Save</Button>
            <Button onClick={() => setTagEditor(null)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>
```

- [ ] **Step 4: Build**

Run (raiz): `npm run build 2>&1 | tail -20`
Expected: build sem erros. (`Badge` aceita `variant` `default|primary|success|warning|error|info` e `size` `sm|md|lg`.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js"
git commit -m "feat(keys): edit API key tags from the endpoint page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Verificação completa (suite, build, smoke com cópia do DB de produção)

**Files:**
- Modify: `/home/ubuntu/src/9router/.claude/index/{app,lib,ops}.md` (índices locais, fora do git)

**Interfaces:**
- Consumes: tudo das Tasks 1–13.
- Produces: evidência de que funciona com dados reais.

- [ ] **Step 1: Suite inteira**

```bash
export npm_config_cache=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/npm-cache
cd /home/ubuntu/src/9router/.worktrees/usage-filters/tests
npx vitest run --reporter=json --outputFile=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/now.json > /dev/null 2>&1
node -e '
const fs = require("fs");
const fails = (p) => new Set(JSON.parse(fs.readFileSync(p, "utf8")).testResults.flatMap((f) =>
  f.assertionResults.filter((a) => a.status === "failed").map((a) => f.name.split("/tests/")[1] + " :: " + a.fullName)));
const base = fails(process.argv[1]);
const now = fails(process.argv[2]);
const regressions = [...now].filter((x) => !base.has(x));
console.log(regressions.length ? "REGRESSIONS:\n" + regressions.join("\n") : `no regressions (${now.size} failing, all pre-existing)`);
process.exit(regressions.length ? 1 : 0);
' /home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/baseline.json /home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/now.json
```

Expected: `no regressions (...)` — ou só falhas que sumiram (corrigidas). Atenção a testes que dependiam de `HOME` real: se algum passou a falhar só por causa do isolamento da Task 4, ajuste o teste para criar o que precisa no `HOME` temporário, nunca remova o isolamento. **Nenhuma falha nova.** Se aparecer falha nova, use superpowers:systematic-debugging.

- [ ] **Step 2: Build de produção**

```bash
cd /home/ubuntu/src/9router/.worktrees/usage-filters && npm run build 2>&1 | tail -15
```

Expected: build sem erros.

- [ ] **Step 3: Smoke com uma cópia do DB de produção (porta 20199, sem login)**

```bash
SMOKE=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/smoke && rm -rf $SMOKE && mkdir -p $SMOKE/db
sqlite3 /home/ubuntu/.9router/db/data.sqlite ".backup '$SMOKE/db/data.sqlite'"
sqlite3 $SMOKE/db/data.sqlite "UPDATE settings SET data = json_set(data, '$.requireLogin', json('false')) WHERE id = 1;"
cd /home/ubuntu/src/9router/.worktrees/usage-filters
DATA_DIR=$SMOKE npx next start --port 20199 > $SMOKE/server.log 2>&1 &
sleep 8
```

Isso só altera a **cópia** (`requireLogin=false`). O DB de produção não é tocado. Se `next start` reclamar do build standalone, use `DATA_DIR=$SMOKE npx next dev --webpack --port 20199`.

Verifique:

```bash
B=http://127.0.0.1:20199
curl -s $B/api/usage/filter | jq '{filter, providers: [.options.providers[].id], keys: [.options.apiKeys[].name]}'
sqlite3 $SMOKE/db/data.sqlite "PRAGMA table_info(apiKeys);" | grep tags
sqlite3 $SMOKE/db/data.sqlite "SELECT name FROM sqlite_master WHERE name='idx_uh_apikey_ts';"
curl -s "$B/api/usage/stats?period=all" | grep -c "sk-" # esperado: 0
HERMES=$(sqlite3 $SMOKE/db/data.sqlite "SELECT id FROM apiKeys WHERE name='hermesKey'")
curl -s -X PUT $B/api/usage/filter -H 'content-type: application/json' -d "{\"apiKeys\":{\"mode\":\"selected\",\"ids\":[\"$HERMES\"]}}" | jq .
curl -s "$B/api/usage/stats?period=all" | jq '{filterActive, totalRequests, totalPromptTokens}'
sqlite3 $SMOKE/db/data.sqlite "SELECT count(*), sum(promptTokens) FROM usageHistory u JOIN apiKeys k ON k.key = u.apiKey WHERE k.name='hermesKey';"
```

Expected:
- a coluna `tags` e o índice existem;
- `grep -c "sk-"` = `0`;
- `totalRequests`/`totalPromptTokens` filtrados **iguais** ao `count`/`sum` do SQL direto (no planejamento: 2045 / 177.326.544, mais o que chegou depois).

Registro universal (com o servidor de smoke ainda de pé):

```bash
curl -s -o /dev/null $B/v1/models
curl -s -o /dev/null -X POST $B/v1/chat/completions -H 'content-type: application/json' -d '{bad json'
curl -s -o /dev/null -X POST $B/v1/chat/completions -H 'content-type: application/json' -d '{"model":"nao-existe/x","messages":[{"role":"user","content":"oi"}]}'
sleep 1
sqlite3 $SMOKE/db/data.sqlite "SELECT endpoint, kind, status, httpStatus, provider, model FROM usageHistory ORDER BY id DESC LIMIT 3;"
```

Expected (mais novo primeiro): as duas chamadas de chat → `work|error|4xx`. Com `requireApiKey` ligado na cópia de produção, as duas dão `401` (sem chave) e `model` pode ficar `unknown`. Sem ele, dão 400 (JSON inválido) e 400/404 (modelo inexistente). `/v1/models` → `meta|ok|200|9router`. **Cada chamada gerou exatamente uma linha.** Para ver o caminho com chave, repita a chamada de chat com `-H "authorization: Bearer $(sqlite3 $SMOKE/db/data.sqlite "SELECT key FROM apiKeys WHERE name='phpstorm'")"`. A linha nova deve ter o `apiKey` da chave phpstorm e aparecer no filtro por essa chave.

Depois teste a UI: abra `http://127.0.0.1:20199/dashboard/usage` (pelo navegador da máquina ou pedindo ao usuário via túnel SSH `ssh -L 20199:127.0.0.1:20199`) e confira:
1. dropdowns Providers e API Keys;
2. selecionar uma chave muda cards, gráfico, By Provider, Top Models, ranking e tabelas;
3. o ranking por tag;
4. "Reset filters";
5. em `/dashboard`, editar tags de uma chave e vê-las no filtro após recarregar;
6. o seletor Work / Metadata / All: em Metadata aparecem as chamadas a `/v1/models`; em Work, os números batem com o SQL acima.

Encerre:

```bash
kill %1 2>/dev/null || pkill -f "next start --port 20199" || pkill -f "next dev --webpack --port 20199"
```

- [ ] **Step 4: Atualizar índices locais (fora do git)**

- `/home/ubuntu/src/9router/.claude/index/app.md`: na linha de Usage APIs, acrescente `usage/filter` (GET/PUT); na linha de `/dashboard/usage`, acrescente `UsageFilterBar`, `useUsageFilter`, `usageFilterState`, `ApiKeyRankingCard`, `apiKeyRanking`.
- `/home/ubuntu/src/9router/.claude/index/lib.md`: em `schema.js`, `SCHEMA_VERSION=4`, `apiKeys.tags`, `usageHistory.kind/httpStatus`, `idx_uh_kind_ts`, `idx_uh_apikey_ts`; em Repos, `usageFilterRepo`, `usageApiKeyRedaction`; em libs, `usageFilter.js`, `apiKeyTags.js`, `requestKind.js`, `requestUsage.js` (toda rota `/v1*` é embrulhada por `withRequestUsage`).
- `/home/ubuntu/src/9router/.claude/index/ops.md`: plano `2026-10-01-usage-filters`, implementado no branch `feat/usage-filters` (worktree `.worktrees/usage-filters`), substitui `2026-09-04-usage-provider-filter-and-tts`.

- [ ] **Step 5: Commit (se a Step 1/2 exigiu correções)**

```bash
git status --short   # só commitar se houver correções
```

---

### Task 15: Deploy em produção (com backup e rollback)

**Files:** nenhum no repositório. Mexe em `/home/ubuntu/.local/lib/node_modules/9router` e no processo da porta 20128.

**Interfaces:**
- Consumes: branch `feat/usage-filters` verificado (Task 14).
- Produces: produção rodando 0.5.95 + feature.

> ⚠️ **Pare e peça confirmação explícita ao usuário antes da Step 4.** O live-test (YouTube 24/7) usa `https://9router.guimcastro.com.br/v1` para chat e TTS e vai ficar fora do ar por 1–3 minutos. Combine o horário com o usuário.

- [ ] **Step 1: Estado atual**

```bash
grep '"version"' /home/ubuntu/.local/lib/node_modules/9router/package.json   # esperado no planejamento: 0.5.91
ps -eo pid,cmd | grep "9router --tray" | grep -v grep
ss -ltnp | grep 20128
```

- [ ] **Step 2: Backup**

```bash
TS=$(date +%Y%m%d-%H%M%S); BK=/home/ubuntu/backups/9router-pre-usage-filters-$TS; mkdir -p $BK
sqlite3 /home/ubuntu/.9router/db/data.sqlite ".backup '$BK/data.sqlite'"
cp -a /home/ubuntu/.local/lib/node_modules/9router $BK/pkg
echo $BK > /home/ubuntu/backups/9router-last-backup
ls -la $BK
```

- [ ] **Step 3: Gerar o pacote**

```bash
cd /home/ubuntu/src/9router/.worktrees/usage-filters
export npm_config_cache=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/npm-cache
npm --prefix cli install --no-audit --no-fund
npm run cli:pack 2>&1 | tail -15
ls -la 9router-*.tgz
```

Expected: `9router-0.5.95.tgz` na raiz do worktree. Não commitar o `.tgz`. Se o build da CLI falhar, leia `cli/scripts/build-cli.js` antes de tentar outra coisa.

- [ ] **Step 4: Trocar a versão (com o usuário de acordo)**

```bash
pkill -f "9router --tray --skip-update -p 20128"; sleep 3
ss -ltnp | grep 20128 || echo "porta livre"
npm_config_cache=/home/ubuntu/src/9router/.worktrees/.usage-filters-tmp/npm-cache /home/ubuntu/.local/bin/npm i -g --prefix /home/ubuntu/.local /home/ubuntu/src/9router/.worktrees/usage-filters/9router-0.5.95.tgz
cd /home/ubuntu && setsid nohup /home/ubuntu/.local/bin/9router --tray --skip-update -p 20128 > /home/ubuntu/.9router/logs/tray-usage-filters.log 2>&1 < /dev/null &
sleep 10
```

**Mantenha `--skip-update`.** Sem ele, o auto-update sobrescreve com a versão do npm.

- [ ] **Step 5: Verificar produção**

```bash
grep '"version"' /home/ubuntu/.local/lib/node_modules/9router/package.json     # 0.5.95
ss -ltnp | grep 20128
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:20128/api/health    # 200
sqlite3 /home/ubuntu/.9router/db/data.sqlite "PRAGMA table_info(apiKeys);" | grep tags
sqlite3 /home/ubuntu/.9router/db/data.sqlite "SELECT name FROM sqlite_master WHERE name='idx_uh_apikey_ts';"
tail -20 /home/ubuntu/.9router/logs/tray-usage-filters.log
```

Espere o live-test fazer requests de chat e TTS e confirme que elas foram registradas (uma linha cada, com `kind` e `httpStatus`):

```bash
sqlite3 /home/ubuntu/.9router/db/data.sqlite "SELECT timestamp, provider, model, endpoint, kind, status, httpStatus FROM usageHistory ORDER BY id DESC LIMIT 10;"
sqlite3 /home/ubuntu/.9router/db/data.sqlite "SELECT kind, status, count(*) FROM usageHistory WHERE timestamp >= datetime('now', '-30 minutes') GROUP BY 1, 2;"
```

Peça ao usuário para abrir `https://9router.guimcastro.com.br/dashboard/usage`, filtrar por `live24/7` e conferir os números.

- [ ] **Step 6: Rollback (só se algo der errado)**

```bash
BK=$(cat /home/ubuntu/backups/9router-last-backup)
pkill -f "9router --tray --skip-update -p 20128"; sleep 3
rm -rf /home/ubuntu/.local/lib/node_modules/9router && cp -a $BK/pkg /home/ubuntu/.local/lib/node_modules/9router
cd /home/ubuntu && setsid nohup /home/ubuntu/.local/bin/9router --tray --skip-update -p 20128 > /home/ubuntu/.9router/logs/tray-rollback.log 2>&1 < /dev/null &
```

A coluna `tags` e o índice novos são aditivos e o 0.5.91 os ignora. Só restaure `$BK/data.sqlite` se o DB estiver corrompido, e com o processo parado.

- [ ] **Step 7: Registrar**

- Atualize `/home/ubuntu/src/9router/.claude/index/ops.md` → produção agora é **0.5.95 + feat/usage-filters** (build local), com o caminho do backup.
- Atualize a memória `project-code-indexes.md`: produção = build local 0.5.95 com usage filters (não é mais o pacote npm puro).
- Pergunte ao usuário se quer `git push -u origin feat/usage-filters`, PR, e se pode remover o worktree antigo `.worktrees/usage-provider-filter-tts`.
