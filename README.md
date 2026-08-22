# Field Operations Book — versão standalone

App para registro diário de operações a campo (preparo de solo, plantio, pulverização,
colheita), com KPIs de eficiência, mapa real dos talhões (importado de KML) e login
por usuário com dois perfis: **Gestor** (cadastros + relatórios) e **Operador**
(lançamentos + relatórios).

Este pacote já vem com o código pronto. Falta só **criar sua conta gratuita no
Supabase** e **rodar alguns comandos**. Siga a ordem abaixo.

---

## Atualizado — o que tem de novo nesta versão

Se você já tinha rodado uma versão anterior deste projeto, **rode o `schema.sql`
de novo** (ele é seguro de rodar mais de uma vez) para aplicar as mudanças:

- Hierarquia **Fazenda → Retiro → Talhão** (tabela `retiros` nova).
- Talhões só são criados via **importação de KML** (sem cadastro manual).
- Cadastro de **Máquinas**, com seleção obrigatória no lançamento.
- Tipos de **Operação configuráveis** (ativar/desativar os padrão, criar novos).
- Novo perfil de usuário **Supervisor** (só visualiza o Painel).
- Lançamento por **horímetro inicial/final** (horas calculadas automaticamente,
  com validações: final ≥ inicial e diferença ≤ 24h).
- Validação de área trabalhada: nunca pode passar de **110%** da área do talhão.
- Painel com filtros de Operação, Retiro, Operador e Período, KPIs recalculados
  (Área no período, Rendimento operacional, Área média/dia, Horas/dia).
- Mapa de satélite com **zoom, arrastar (pan)** e botões para mostrar/ocultar
  nome, área e percentual de cada talhão — e aqui, fora do sandbox do Claude,
  a **foto de satélite real carrega normalmente**.

---

## Passo 1 — Criar o projeto no Supabase

1. Crie uma conta gratuita em [supabase.com](https://supabase.com) e clique em **New project**.
2. Anote a senha do banco que você definir (só é usada internamente, não precisa guardar para o app).
3. Espere o projeto terminar de ser criado (leva ~2 minutos).

## Passo 2 — Rodar o schema do banco

1. No painel do Supabase, abra **SQL Editor**.
2. Cole todo o conteúdo do arquivo [`supabase/schema.sql`](./supabase/schema.sql) deste pacote e clique em **Run**.
   Isso cria as tabelas (`profiles`, `farms`, `fields`, `operations`), as permissões
   por perfil (Operador/Gestor) e a função de login por usuário.
3. Vá em **Authentication → Providers → Email** e **desative "Confirm email"**.
   (o app usa um e-mail interno fictício tipo `joao@fieldbook.local` — sem
   desativar essa opção, o primeiro login não funciona.)

## Passo 3 — Publicar a Edge Function (criação de usuários pelo Gestor)

Isso permite que o Gestor crie novos usuários (Operador/Gestor) direto pela tela
"Cadastro" do app, sem expor nenhuma chave sensível no navegador.

1. Instale a CLI do Supabase (uma vez só na sua máquina):
   ```bash
   npm install -g supabase
   ```
2. Faça login e associe ao seu projeto:
   ```bash
   supabase login
   supabase link --project-ref SEU-PROJECT-REF
   ```
   (o `PROJECT-REF` aparece na URL do seu projeto, algo como `abcdefghij.supabase.co` → `abcdefghij`)
3. Publique a function:
   ```bash
   supabase functions deploy create-user
   ```
   As variáveis `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`
   já ficam disponíveis automaticamente dentro da function — não precisa configurar nada.

## Passo 4 — Pegar as chaves do projeto

No painel do Supabase, vá em **Project Settings → API** e copie:
- **Project URL**
- **anon public key**

## Passo 5 — Rodar o app na sua máquina

```bash
npm install
cp .env.example .env
# edite o .env e cole a Project URL e a anon key do Passo 4
npm run dev
```

Abra o endereço que aparecer no terminal (geralmente `http://localhost:5173`).
Na primeira vez, a tela vai pedir para criar o usuário **Gestor** inicial —
esse é o único usuário criado "manualmente"; os demais (Operadores e outros
Gestores) são criados por ele, dentro do app, na aba Cadastro.

## Passo 6 — Publicar na internet (Vercel)

1. Suba este projeto para um repositório no GitHub.
2. Em [vercel.com](https://vercel.com), clique em **Add New → Project** e
   selecione o repositório.
3. Em **Environment Variables**, adicione as mesmas duas variáveis do `.env`:
   `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
4. Clique em **Deploy**. Em poucos minutos você recebe uma URL própria
   (ex: `field-operations-book.vercel.app`), acessível de qualquer dispositivo.
5. Repita esse deploy automaticamente a cada `git push` — a Vercel já cuida disso.

## Passo 7 — Instalar no celular (PWA)

Depois de publicado, abra a URL no celular do operador (Chrome no Android ou
Safari no iPhone) e use a opção **"Adicionar à tela inicial"**. O app abre em
tela cheia, com ícone próprio, como um aplicativo nativo.

---

## Estrutura do projeto

```
field-operations-book/
├── supabase/
│   ├── schema.sql              → tabelas + permissões (rodar no SQL Editor)
│   └── functions/create-user/  → Edge Function para o Gestor criar usuários
├── src/
│   ├── App.jsx                 → toda a interface e lógica do app
│   ├── supabaseClient.js       → conexão com o Supabase
│   └── main.jsx                → ponto de entrada do React
├── public/icons/                → ícones do PWA (placeholders — troque pelos seus)
├── vite.config.js               → build + configuração do PWA
└── .env.example                 → onde colar as chaves do Supabase
```

## Sobre os ícones

Os arquivos em `public/icons/` são placeholders simples gerados automaticamente.
Troque `icon-192.png` e `icon-512.png` por uma logomarca própria quando quiser
(mesmos nomes e tamanhos: 192×192 e 512×512 pixels).

## Próximos passos possíveis (não incluídos neste pacote)

- **Modo offline com sincronização**: guardar lançamentos localmente (IndexedDB)
  quando não há sinal no campo, e enviar ao Supabase quando a conexão voltar.
- **Polígonos com PostGIS de verdade**: hoje os polígonos do KML são guardados
  como coordenadas simples (`jsonb`); é possível evoluir para geometria PostGIS
  nativa se um dia precisar de consultas espaciais mais avançadas (interseção
  de áreas, buffers, etc).
- **Domínio próprio** na Vercel, em vez do endereço `.vercel.app` padrão.

Qualquer uma dessas partes, é só pedir que detalhamos e implementamos.
